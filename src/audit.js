/**
 * 操作审计:谁、什么时候、对哪个实例做了什么。
 *
 * 做成**通用中间件**而不是在每个路由里手写一行 —— 后者一定会漏,
 * 而且新增路由时没人记得补。代价是动作名要从 method+path 反推,
 * 所以下面有一张路径 → 中文动作的对照表,匹配不到就退化成 "METHOD /path"。
 *
 * 落在 data/audit.log,一行一条 JSON。超过上限滚一次(只留一个 .1),
 * 审计日志自己把磁盘写满就太讽刺了。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { DATA_DIR } = require('./config');

const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const AUDIT_OLD = AUDIT_FILE + '.1';
const MAX_BYTES = Math.max(1, parseInt(process.env.MCSP_AUDIT_MB, 10) || 16) * 1048576;

/* 查询时最多往回翻多少字节。日志攒到十几 MB 时,"把整个文件读进来再逐行 parse"
   会同步卡住事件循环几百毫秒 —— 那期间**整个面板**都停着(实测 16 MB 日志下
   一次查询让 /api/health 从 0.8ms 飙到 282ms)。审计页要的是最近发生了什么,
   回看这么多已经足够,代价从"随文件线性增长"变成有上界。 */
const MAX_SCAN_BYTES = 4 * 1048576;
const SCAN_CHUNK = 256 * 1024;

/* 这些字段一律不入库 —— 审计日志本身不该成为凭据泄露点 */
const SECRET_KEYS = /pass|token|secret|authtoken|clientsecret|credential/i;

/** 路径模式 → 动作名。:iid 之类已被替换成 * 再匹配 */
const ACTIONS = [
  [/^POST \/instances$/, '创建实例'],
  [/^DELETE \/instances\/\*$/, '删除实例'],
  [/^PATCH \/instances\/\*$/, '修改实例配置'],
  [/^POST \/instances\/\*\/clone$/, '克隆实例'],
  [/^POST \/instances\/\*\/reinstall$/, '重装/换版本'],
  [/^POST \/instances\/\*\/server\/(\w+)$/, '实例电源操作'],
  [/^POST \/instances\/\*\/command$/, '执行控制台命令'],
  [/^POST \/instances\/\*\/players\//, '玩家管理'],
  [/^PUT \/instances\/\*\/properties$/, '保存 server.properties'],
  [/^POST \/instances\/\*\/backups$/, '创建备份'],
  [/^POST \/instances\/\*\/backups\/\*\/restore$/, '恢复备份'],
  [/^DELETE \/instances\/\*\/backups\/\*$/, '删除备份'],
  /* 分片上传会命中 /files/upload/init|finish;chunk 在中间件里就被跳过了,
     不然一个 4 GB 的包能写出 800 条审计,把 16 MB 的轮转冲干净 */
  [/^POST \/instances\/\*\/files\/upload(\/(init|finish|abort))?$/, '上传文件'],
  [/^PUT \/instances\/\*\/files\/content$/, '编辑文件'],
  [/^DELETE \/instances\/\*\/files$/, '删除文件'],
  [/^POST \/instances\/\*\/files\/extract$/, '解压'],
  [/^POST \/instances\/\*\/files\/archive$/, '打包'],
  [/^POST \/instances\/\*\/files\/rename$/, '重命名文件'],
  [/^POST \/instances\/\*\/tasks/, '计划任务变更'],
  [/^DELETE \/instances\/\*\/tasks/, '删除计划任务'],
  [/^PUT \/instances\/\*\/tunnel$/, '保存穿透配置'],
  [/^POST \/instances\/\*\/tunnel\//, '穿透启停'],
  [/^POST \/users$/, '创建用户'],
  [/^DELETE \/users\/\*$/, '删除用户'],
  [/^PUT \/users\/\*\/limits$/, '修改用户配额'],
  [/^PUT \/users\/\*\/password$/, '重置用户密码'],
  [/^PUT \/settings/, '修改系统设置'],
  [/^POST \/settings\/notify\/test$/, '测试告警推送'],
  [/^PUT \/auth\/password$/, '修改自己的密码'],
  [/^POST \/auth\/login$/, '登录'],
  [/^POST \/auth\/logout$/, '登出'],
  [/^POST \/java\/install$/, '安装 Java 运行时'],
  [/^POST \/tunnel\/components\//, '安装穿透组件'],
];

/** 把路径里的 id 段换成 *,让上面的表能匹配 */
function normalize(p) {
  return p
    .replace(/^\/api/, '')
    .split('?')[0]
    .split('/')
    .map((seg, i, arr) => {
      if (!seg) return seg;
      // instances/<id>、users/<name>、backups/<file>、tasks/<uuid> 的下一段视为 id
      const prev = arr[i - 1];
      if (['instances', 'users', 'backups', 'tasks'].includes(prev)) return '*';
      return seg;
    })
    .join('/');
}

function actionOf(method, url) {
  const key = `${method} ${normalize(url)}`;
  for (const [re, name] of ACTIONS) if (re.test(key)) return name;
  return key;
}

/** 递归剔除敏感字段,并把过长的值截断 */
function redact(value, depth = 0) {
  if (depth > 4 || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEYS.test(k) ? '***' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 200) return value.slice(0, 200) + '…';
  return value;
}

/* 当前文件大小自己记着,免得每写一条都 statSync 一次。
   启动时问一次磁盘,之后按写入量累加,轮转后清零 */
let curBytes = (() => { try { return fs.statSync(AUDIT_FILE).size; } catch { return 0; } })();

function rotate() {
  try {
    fs.rmSync(AUDIT_OLD, { force: true });
    fs.renameSync(AUDIT_FILE, AUDIT_OLD);
    curBytes = 0;
  } catch { /* 文件还不存在 */ }
}

/* 攒批异步写。
 *
 * 原来每条都 appendFileSync + statSync,而审计中间件挂在所有写请求上 ——
 * 等于每个 POST/PUT/DELETE 都要同步落一次盘。改成攒到下一个事件循环节拍
 * 一次性 append,窗口只有一个 tick,却把两次同步系统调用从请求路径上摘掉了。
 *
 * 代价是进程被 SIGKILL 时可能丢掉最后一个 tick 内的条目;正常退出有下面的
 * exit 钩子兜底。审计日志不是账本,这个取舍值。
 */
let pending = [];
let flushing = false;
let scheduled = false;

async function flush() {
  if (flushing || !pending.length) return;
  flushing = true;
  const batch = pending;
  pending = [];
  const text = batch.join('');
  try {
    if (curBytes >= MAX_BYTES) rotate();
    await fsp.appendFile(AUDIT_FILE, text);
    curBytes += Buffer.byteLength(text);
  } catch (err) {
    console.error('[MCSP] 审计日志写入失败:', err.message);
  } finally {
    flushing = false;
    if (pending.length) schedule();
  }
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setImmediate(() => { scheduled = false; flush(); });
}

function write(entry) {
  pending.push(JSON.stringify(entry) + '\n');
  schedule();
}

/* 正常退出时把没落盘的补上 —— 这里只能同步写 */
process.on('exit', () => {
  if (!pending.length) return;
  try { fs.appendFileSync(AUDIT_FILE, pending.join('')); } catch {}
  pending = [];
});

/**
 * Express 中间件:记录所有会改变状态的 /api 请求。
 * 在响应结束后才写 —— 这样能连状态码一起记下来,失败的尝试(403/404)
 * 同样有痕迹,这恰恰是排查越权时最想看的。
 */
function middleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  /* 分片本身不记:一次上传有几十上百片,每片一条会把审计日志冲垮,而
     "谁在什么时候传了什么"这件事 init 和 finish 已经说清楚了 */
  if (req.path.endsWith('/files/upload/chunk')) return next();
  const startedAt = Date.now();
  res.on('finish', () => {
    // /api/stream 之类的长连接不记
    if (res.statusCode === 101) return;
    write({
      at: Date.now(),
      user: (req.user && req.user.username) || (req.body && req.body.username) || '-',
      ip: req.ip,
      action: actionOf(req.method, req.originalUrl),
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Date.now() - startedAt,
      // 上传的 body 是文件原始字节,不是 JSON —— 别把二进制塞进审计日志
      params: req.is('application/json') ? redact(req.body) : undefined,
    });
  });
  next();
}

/**
 * 倒序读取最近的审计条目,支持按用户/关键词过滤。
 *
 * 从文件**末尾往前**分块读,边读边筛,最多回看 MAX_SCAN_BYTES。三个要点:
 *   · 异步 I/O —— 不再拿同步读堵住整个面板;
 *   · 过滤在**原始行文本**上做,只有要返回的那几条才 JSON.parse。
 *     原来是每条都 parse 一遍、搜索时再 stringify 回去,纯属白烧 CPU;
 *   · 扫描量有上界,不再随日志文件一起长。
 *
 * 返回的 total 是**扫描窗口内**的命中数;窗口没覆盖到文件开头时 truncated 为 true,
 * 前端据此把话说清楚,不会把"最近 4MB 里有 300 条"说成"总共就 300 条"。
 */
async function read({ limit = 200, q = '', user = '' } = {}) {
  const cap = Math.max(1, Math.min(2000, parseInt(limit, 10) || 200));
  const needle = q ? String(q).toLowerCase() : '';
  // 用户名也在原始文本上筛:JSON 里就是 "user":"xxx" 这一段,省掉一次 parse
  const userNeedle = user ? `"user":${JSON.stringify(String(user))}` : '';

  const rows = [];
  let total = 0;
  let budget = MAX_SCAN_BYTES;
  let truncated = false;

  // 先新后旧:当前文件读完了还有预算,再往轮转出去的那份里翻
  for (const file of [AUDIT_FILE, AUDIT_OLD]) {
    if (budget <= 0) { truncated = true; break; }
    let fh;
    try { fh = await fsp.open(file, 'r'); } catch { continue; }
    try {
      let pos = (await fh.stat()).size;
      let carry = '';                     // 块首那半行,留给下一块拼
      while (pos > 0 && budget > 0) {
        const len = Math.min(SCAN_CHUNK, pos, budget);
        pos -= len;
        budget -= len;
        const buf = Buffer.allocUnsafe(len);
        await fh.read(buf, 0, len, pos);
        const lines = (buf.toString('utf8') + carry).split('\n');
        carry = pos > 0 ? lines.shift() : '';   // 还没读到文件头,首段可能被截断
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i];
          if (!line || !line.trim()) continue;
          if (userNeedle && !line.includes(userNeedle)) continue;
          if (needle && !line.toLowerCase().includes(needle)) continue;
          total++;
          if (rows.length < cap) {
            try { rows.push(JSON.parse(line)); } catch { total--; }
          }
        }
      }
      if (pos > 0) truncated = true;      // 预算用完了,前面还有没看的
    } finally {
      await fh.close();
    }
  }
  return { total, rows, truncated };
}

module.exports = { middleware, read, actionOf, redact };
