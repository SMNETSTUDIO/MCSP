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

module.exports = { ts, stripAnsi, readJson, writeJson, dirSize, runCmd, downloadFile, githubLatestTag, asyncHandler };
