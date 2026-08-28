/** 通用工具:时间戳、ANSI 清洗、JSON 读写、目录大小、下载、子进程、出站地址校验 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const net = require('net');
const dns = require('dns').promises;
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

/* ── 出站地址校验(SSRF) ──────────────────────────────────────────
 *
 * 面板会拿**用户填的地址**发请求:告警 webhook / Discord / Telegram、异地备份的
 * S3 endpoint 与 WebDAV、OAuth 的 authorize/token/userinfo。原先只校验协议是
 * http(s),不校验地址 —— 于是 `http://169.254.169.254/latest/meta-data/`
 * (云元数据,能读到实例角色的临时凭据)、`http://127.0.0.1:25575`、`http://10.0.0.x`
 * 一律放行。而"测试推送"会把每个通道的错误文本回显给调用者,响应时间 + 错误内容
 * 足以区分"端口开着"和"连不上" —— 这就是一个带回显的内网探测原语。
 *
 * ARCHITECTURE.md 写着"别把面板变成内网探测器",这里是把那句话真正落实。
 *
 * 已知局限:解析完到 fetch 真正连接之间有 DNS rebinding 窗口。彻底堵死要自定义
 * agent 的 lookup,成本远高于收益 —— 这些接口都是 requireAdmin,威胁模型是
 * "管理员被钓鱼点了一下",不是"租户主动打内网"。这里挡住直接填内网地址的情形。
 */
const PRIVATE_V4 = [
  [[0, 0, 0, 0], 8],          // 本网络
  [[10, 0, 0, 0], 8],         // 私有
  [[100, 64, 0, 0], 10],      // CGNAT
  [[127, 0, 0, 0], 8],        // 环回
  [[169, 254, 0, 0], 16],     // 链路本地(含 169.254.169.254 云元数据)
  [[172, 16, 0, 0], 12],      // 私有
  [[192, 0, 0, 0], 24],       // IETF 保留
  [[192, 168, 0, 0], 16],     // 私有
  [[198, 18, 0, 0], 15],      // benchmark
  [[224, 0, 0, 0], 4],        // 组播
  [[240, 0, 0, 0], 4],        // 保留 + 广播
];

function v4InCidr(ip, base, bits) {
  const a = ip.split('.').map(Number);
  if (a.length !== 4 || a.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const toInt = (p) => ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(a) & mask) === (toInt(base) & mask);
}

/** 这个 IP 是不是内网/环回/链路本地等不该被面板主动访问的地址 */
function isPrivateAddress(ip) {
  const v = net.isIP(ip);
  if (v === 4) return PRIVATE_V4.some(([base, bits]) => v4InCidr(ip, base, bits));
  if (v === 6) {
    const s = ip.toLowerCase();
    if (s === '::' || s === '::1') return true;
    // IPv4-mapped(::ffff:10.0.0.1)必须按内嵌的 v4 判,否则是个现成的绕过口
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (m) return isPrivateAddress(m[1]);
    if (/^f[cd][0-9a-f]{2}:/.test(s)) return true;      // fc00::/7 唯一本地
    if (/^fe[89ab][0-9a-f]:/.test(s)) return true;      // fe80::/10 链路本地
    return false;
  }
  return false;
}

/**
 * 校验用户填的出站 URL。通过返回 null,不通过返回中文原因(可直接回给用户)。
 * 域名会走 DNS 解析,**所有**解析结果里只要有一个是内网地址就拒绝。
 */
async function checkOutboundUrl(raw, { label = '目标地址' } = {}) {
  let u;
  try { u = new URL(String(raw)); } catch { return `${label}不是合法 URL`; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return `${label}只支持 http/https`;

  const host = u.hostname.replace(/^\[|\]$/g, '');    // IPv6 字面量带方括号
  if (net.isIP(host)) {
    return isPrivateAddress(host) ? `${label}指向内网/环回地址(${host}),已拒绝` : null;
  }
  if (/^localhost$/i.test(host) || /\.localhost$/i.test(host)) return `${label}指向 localhost,已拒绝`;

  let addrs;
  try {
    addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
  } catch {
    return `${label}的域名解析失败(${host})`;
  }
  const bad = addrs.find((a) => isPrivateAddress(a));
  return bad ? `${label}的域名解析到内网地址(${host} → ${bad}),已拒绝` : null;
}

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
  isPrivateAddress, checkOutboundUrl,
};
