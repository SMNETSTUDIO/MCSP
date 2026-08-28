/** 通用工具:时间戳、ANSI 清洗、JSON 读写、目录大小、下载、子进程 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');

function ts() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const stripAnsi = (s) => s
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')   // CSI 序列
  .replace(/\x1b[0-9A-Za-z<=>]/g, '');      // ESC+单字符(TUI 光标保存/恢复等)

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

/**
 * 先写临时文件再 rename —— 同一文件系统上 rename 是原子的。
 *
 * 直接覆盖写的话,进程在写到一半时被杀(OOM / 断电 / kill -9)会留下一个截断的
 * JSON。读端虽然有 fallback,但那意味着 **users.json 变成空数组** ——
 * 所有账号一起没了。这几个文件(账号、会话、实例注册表、计划任务)丢一个都很痛,
 * 多一次 rename 换一个"要么是旧的完整内容、要么是新的完整内容"值。
 */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) {
      try { total += (await fsp.stat(p)).size; } catch {}
    }
  }
  return total;
}

function runCmd(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} 退出码 ${code}`))));
    p.on('error', reject);
  });
}

async function downloadFile(url, dest, onProgress) {
  const res = await fetch(url, { signal: AbortSignal.timeout(300000), redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
  const total = parseInt(res.headers.get('content-length'), 10) || 0;
  const file = fs.createWriteStream(dest);
  const reader = res.body.getReader();
  let received = 0, lastPct = -1;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    file.write(value);
    received += value.length;
    if (total && onProgress) {
      const pct = Math.floor((received / total) * 100);
      if (pct !== lastPct) { lastPct = pct; onProgress(pct); }
    }
  }
  await new Promise((r, j) => file.end((e) => (e ? j(e) : r())));
}

async function githubLatestTag(repo, fallback) {
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) return (await r.json()).tag_name.replace(/^v/, '');
  } catch {}
  return fallback;
}

/** Express 异步路由包装:未捕获的 rejection 交给错误中间件而不是打崩进程 */
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

/**
 * 一个 `-Xmx=xmxMB` 的 JVM 实际会向宿主机要多少内存(RSS 口径)。
 *
 * `-Xmx` 只管**堆**。Metaspace、Code Cache、线程栈、GC 自身的数据结构,以及 Netty 的
 * direct buffer 全在堆外 —— MC 服务端的网络层就是 Netty,这块吃得不少。实测 `-Xmx4G`
 * 的 Paper 稳定运行时 RSS 常在 4.5G 以上,重模组服更多。
 *
 * 所以按 Σ-Xmx 把宿主机排满,实际 RSS 之和一定会超,而超出来的那部分不会报错,
 * 是 OOM killer 在半夜随机挑一个服务端杀掉 —— 沉默的故障比拒绝服务更难查。
 *
 * 余量取「百分比」与「固定下限」的较大值:小堆按比例算不够(1G 堆的 13% 只有 133M,
 * 盖不住 Metaspace + CodeCache + 线程栈),大堆按固定值算又不够(重模组服 class 多、
 * direct buffer 大)。两个参数都在系统设置里(thresholds),**同时设 0 就退回纯 Σ-Xmx**。
 *
 * settings 用惰性 require:settings.js 自己 require 了本文件,顶层 require 会成环。
 * 同 disk.js 的 diskWarnPct 写法。
 */
function memOverheadMB(xmxMB) {
  const t = require('./settings').get().thresholds;
  const pct = Number.isFinite(t.memOverheadPct) ? t.memOverheadPct : 13;
  const min = Number.isFinite(t.memOverheadMinMB) ? t.memOverheadMinMB : 512;
  return Math.max(min, Math.round((xmxMB * pct) / 100));
}

/** 堆 + 堆外 = 这个实例真正要占的宿主机内存,配额就按这个数算 */
const memFootprintMB = (xmxMB) => xmxMB + memOverheadMB(xmxMB);

module.exports = {
  ts, stripAnsi, readJson, writeJson, dirSize, runCmd, downloadFile, githubLatestTag, asyncHandler,
  memOverheadMB, memFootprintMB,
};
