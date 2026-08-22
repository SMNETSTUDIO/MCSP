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
const path = require('path');
const { DATA_DIR } = require('./config');

const AUDIT_FILE = path.join(DATA_DIR, 'audit.log');
const AUDIT_OLD = AUDIT_FILE + '.1';
const MAX_BYTES = Math.max(1, parseInt(process.env.MCSP_AUDIT_MB, 10) || 16) * 1048576;

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
  [/^POST \/instances\/\*\/files\/upload$/, '上传文件'],
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

function rotateIfNeeded() {
  try {
    if (fs.statSync(AUDIT_FILE).size < MAX_BYTES) return;
    fs.rmSync(AUDIT_OLD, { force: true });
    fs.renameSync(AUDIT_FILE, AUDIT_OLD);
  } catch { /* 文件还不存在 */ }
}

function write(entry) {
  try {
    rotateIfNeeded();
    fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
  } catch (err) {
    console.error('[MCSP] 审计日志写入失败:', err.message);
  }
}

/**
 * Express 中间件:记录所有会改变状态的 /api 请求。
 * 在响应结束后才写 —— 这样能连状态码一起记下来,失败的尝试(403/404)
 * 同样有痕迹,这恰恰是排查越权时最想看的。
 */
function middleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
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

/** 倒序读取最近的审计条目,支持按用户/关键词过滤 */
function read({ limit = 200, q = '', user = '' } = {}) {
  let text = '';
  for (const f of [AUDIT_OLD, AUDIT_FILE]) {
    try { text += fs.readFileSync(f, 'utf8'); } catch {}
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch {}
  }
  let out = rows;
  if (user) out = out.filter((r) => r.user === user);
  if (q) {
    const needle = q.toLowerCase();
    out = out.filter((r) => JSON.stringify(r).toLowerCase().includes(needle));
  }
  return { total: out.length, rows: out.slice(-Math.max(1, Math.min(2000, limit))).reverse() };
}

module.exports = { middleware, read, actionOf, redact };
