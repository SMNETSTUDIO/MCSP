/**
 * 分片上传的会话表与回收。
 *
 * 为什么要分片:面板常被架在隧道 / Cloudflare Worker 后面,这类链路在请求体
 * 10 MB 出头就直接 502(请求压根到不了面板)。把文件切成 5 MB 一片多次上传,
 * 无论前面套多少层小肚量代理都能过。
 *
 * 落盘策略是**一个临时文件 + 按偏移写**:init 先把空文件建出来,每一片经
 * `createWriteStream(tmp, { flags:'r+', start: index*chunkSize })` 写进自己的区间。
 * 并发的分片写的是互不相交的偏移,天然安全,也省掉了"每片一个文件、最后再拼一遍"
 * 的那趟全量读写 —— 几个 GB 的包那一趟不便宜。
 *
 * 会话只存在内存里(不做跨刷新续传),因此进程一重启就会遗留临时文件,
 * 由下面的 GC 负责扫掉。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { INSTANCES_DIR, UPLOAD_SESSION_TTL_MS } = require('./config');

/** uploadId → 会话。uploadId 是能力凭证,见 newUploadId 的说明 */
const sessions = new Map();

/* 单个用户同时开着的会话数上限。没有这道闸,一个脚本调十万次 init 就能
   在不上传任何字节的情况下耗掉 inode 和内存 —— 这是纯分片设计里最容易漏的洞 */
const MAX_SESSIONS_PER_USER = 16;

const GC_INTERVAL_MS = 5 * 60_000;

/* 临时文件前缀。GC 和文件管理器的隐藏过滤都认这个前缀,改动要一起改 */
const TMP_PREFIX = '.mcsp-upload-';

/**
 * uploadId 用 128 位随机数,而不是仓库里其它地方那种 randomUUID().slice(0,8)。
 * 它是一张**能力凭证**:拿到就能往别人的会话里写字节,32 位在面板规模下可猜。
 */
const newUploadId = () => crypto.randomBytes(16).toString('hex');

/** 只认 32 位小写十六进制。先过格式再查表,任何情况下都不拿它拼路径 */
const isUploadId = (s) => typeof s === 'string' && /^[0-9a-f]{32}$/.test(s);

function countByUser(username) {
  let n = 0;
  for (const s of sessions.values()) if (s.username === username) n++;
  return n;
}

/**
 * 建会话:先把临时空文件创出来再返回。
 *
 * 这一步不能省成"第一片到了再懒创建" —— `r+` 打开不存在的文件是 ENOENT 且不会
 * 帮你创建,懒创建就得退化成 `w`,而两个并发分片同时 `w` 会互相截断。
 */
async function create({ iid, username, parentRel, name, tmpDir, size, chunkSize, overwrite }) {
  if (countByUser(username) >= MAX_SESSIONS_PER_USER) {
    throw Object.assign(new Error(`同时进行的上传过多(上限 ${MAX_SESSIONS_PER_USER} 个),请等已有上传完成`), { tooMany: true });
  }
  const uploadId = newUploadId();
  const chunks = Math.ceil(size / chunkSize);
  const tmp = path.join(tmpDir, `${TMP_PREFIX}${uploadId.slice(0, 12)}`);

  const fh = await fsp.open(tmp, 'w');   // 建出来就行,不预分配(见下)
  await fh.close();
  /* 特意不做 ftruncate 预分配:它只会造出一个稀疏文件,一点空间都不预留
     (ENOSPC 该迟到还是迟到),却让 stat().size 立刻等于声明值 ——
     一个谎报 10 TB 的请求会凭空变出一个"看起来 10 TB"的文件。 */

  const now = Date.now();
  const s = {
    uploadId, iid, username, parentRel, name, tmp,
    size, chunkSize, chunks,
    received: new Uint8Array(chunks),   // 0/1 位图,不是字节累加 —— 重传会重复计数
    receivedCount: 0,
    overwrite: !!overwrite,
    createdAt: now, touchedAt: now,
    writing: new Set(),                 // 同一片的并发/重复写入互斥
    finishing: false,
  };
  sessions.set(uploadId, s);
  return s;
}

/**
 * 取会话并核对归属。
 *
 * 三道校验一律返回"不存在"而不是"无权限":和 router.param('iid') 的做法一致,
 * 不给 uploadId 枚举留下"存在但不是你的"这种可区分信号。
 *
 * 跨用户那道比权限门更严 —— 同一实例上的两个 manager 也不能共用会话。会话是
 * 一次私有的在途操作,让 B 去 finish A 的上传会让审计记录变成一句假话。
 */
function get(uploadId, { iid, username }) {
  if (!isUploadId(uploadId)) return null;
  const s = sessions.get(uploadId);
  if (!s) return null;
  if (s.iid !== iid) return null;
  if (s.username !== username) return null;
  return s;
}

/** 丢弃会话:删临时文件 + 退还预扣的配额。幂等 */
async function discard(uploadId) {
  const s = sessions.get(uploadId);
  if (!s) return false;
  sessions.delete(uploadId);
  try { await fsp.rm(s.tmp, { force: true }); } catch {}
  // init 时按声明体积全额预扣过,这里原样退回(bump 自带 max(0,…) 夹底)
  try { require('./disk').bump(s.iid, -s.size / 1048576); } catch {}
  return true;
}

/** finish 成功时调用:会话作废,但临时文件已经 rename 走了,不能再删 */
function forget(uploadId) {
  sessions.delete(uploadId);
}

/* ── 回收 ──
 *
 * 两类泄漏,两种扫法:
 *   1) 客户端关了页面 / 断了网 —— 会话还在表里,按 touchedAt 超时清掉;
 *   2) 面板重启 —— 会话表没了,临时文件成了孤儿,只能按文件 mtime 扫。
 *
 * 超时一律按 touchedAt(最后一片)而不是 createdAt:一个走窄带宽的几 GB 上传
 * 跑几个小时是正常的,不能从底下把它的临时文件抽走。
 */
async function sweepSessions() {
  const now = Date.now();
  for (const [id, s] of [...sessions]) {
    if (now - s.touchedAt > UPLOAD_SESSION_TTL_MS) await discard(id);
  }
}

/**
 * 扫实例目录里的孤儿临时文件。
 *
 * 必须判 mtime:无条件删会把正在进行的上传误杀。顺带也扫 .mcsp-archive-*,
 * 那是打包/解压留下的,原本就没人清。
 */
async function sweepOrphans() {
  const live = new Set([...sessions.values()].map((s) => s.tmp));
  let dirs;
  try { dirs = await fsp.readdir(INSTANCES_DIR, { withFileTypes: true }); } catch { return; }
  const cutoff = Date.now() - UPLOAD_SESSION_TTL_MS;
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    await sweepDir(path.join(INSTANCES_DIR, d.name), live, cutoff);
  }
}

async function sweepDir(dir, live, cutoff) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { await sweepDir(p, live, cutoff); continue; }
    if (!e.isFile()) continue;
    if (!/^\.mcsp-(upload|archive)-/.test(e.name)) continue;
    if (live.has(p)) continue;                       // 有会话正用着
    try {
      if ((await fsp.stat(p)).mtimeMs > cutoff) continue;   // 还新,可能是别的在途操作
      await fsp.rm(p, { force: true });
      console.log(`[MCSP] 已清理残留的上传临时文件: ${path.relative(INSTANCES_DIR, p)}`);
    } catch {}
  }
}

function startUploadGC() {
  sweepOrphans();          // 开机先扫一遍上次进程留下的
  setInterval(() => { sweepSessions().then(sweepOrphans); }, GC_INTERVAL_MS).unref();
}

module.exports = {
  sessions, create, get, discard, forget, isUploadId, startUploadGC,
  TMP_PREFIX, MAX_SESSIONS_PER_USER,
};
