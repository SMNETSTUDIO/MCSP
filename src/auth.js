/**
 * 认证与用户:scrypt 哈希、HttpOnly Cookie 会话(持久化到磁盘,
 * 面板重启不掉线)、登录限速、双角色中间件。
 */
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const {
  USERS_FILE, SESSIONS_FILE, SESSION_TTL_MS, DATA_DIR,
  UPLOAD_CHUNK_MB, UPLOAD_CONCURRENCY, MAX_UPLOAD_MB,
} = require('./config');
const { readJson, writeJson } = require('./utils');
const totp = require('./totp');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
}

/* ── users store ── */

function loadUsers() {
  const u = readJson(USERS_FILE, null);
  if (u) return u;
  const users = [{
    username: 'admin',
    password: hashPassword('admin123'),
    role: 'admin',
    createdAt: Date.now(),
    defaultPassword: true,
  }];
  writeJson(USERS_FILE, users);
  return users;
}

const users = loadUsers();
const saveUsers = () => writeJson(USERS_FILE, users);

/* ── sessions(持久化,重启后仍有效)── */

const sessions = new Map(
  readJson(SESSIONS_FILE, []).filter(([, s]) => Date.now() - s.createdAt < SESSION_TTL_MS)
);

let saveTimer = null;
function saveSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(SESSIONS_FILE, [...sessions]), 500);
}

/* 登录限速。原来只在内存里 —— 面板一重启计数就清零,想爆破的人
   只要能触发一次重启(或者干脆等自动更新)就重新有 5 次机会。落盘。 */
const ATTEMPTS_FILE = path.join(DATA_DIR, 'login-attempts.json');
const loginAttempts = new Map(readJson(ATTEMPTS_FILE, []));
let attemptsTimer = null;
function saveAttempts() {
  clearTimeout(attemptsTimer);
  attemptsTimer = setTimeout(() => {
    // 只留还在锁定期内的,免得这个文件无限增长
    const live = [...loginAttempts].filter(([, a]) => a.until > Date.now());
    loginAttempts.clear();
    for (const [k, v] of live) loginAttempts.set(k, v);
    writeJson(ATTEMPTS_FILE, live);
  }, 500);
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function getSession(req) {
  const token = parseCookies(req).mcsp_session;
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess) return null;
  if (Date.now() - sess.createdAt > SESSION_TTL_MS) { sessions.delete(token); saveSessions(); return null; }
  const user = users.find((u) => u.username === sess.username);
  if (!user) { sessions.delete(token); saveSessions(); return null; }
  // 每分钟最多记一次,否则每个请求都要写盘
  if (Date.now() - (sess.lastSeen || 0) > 60000) { sess.lastSeen = Date.now(); saveSessions(); }
  return { token, username: user.username, role: user.role };
}

/**
 * API Token:给脚本用。存的是 sha256 摘要,明文只在创建那一刻返回一次 ——
 * 和会话 token 不同,这东西会被写进别人的 crontab 里,泄露面更大。
 */
function hashToken(raw) { return crypto.createHash('sha256').update(raw).digest('hex'); }

function findByToken(raw) {
  if (!raw) return null;
  const digest = hashToken(raw);
  for (const u of users) {
    const t = (u.tokens || []).find((x) => x.hash === digest);
    if (t) { t.lastUsed = Date.now(); return { user: u, token: t }; }
  }
  return null;
}

function requireAuth(req, res, next) {
  const sess = getSession(req);
  if (sess) { req.user = sess; return next(); }

  // Authorization: Bearer <token>
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (m) {
    const hit = findByToken(m[1]);
    if (hit) {
      req.user = { username: hit.user.username, role: hit.user.role, viaToken: hit.token.name };
      return next();
    }
    return res.status(401).json({ ok: false, error: 'API Token 无效' });
  }
  return res.status(401).json({ ok: false, error: '未登录或会话已过期' });
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '需要管理员权限' });
  next();
}

/**
 * 强制两步验证(功能 9)。开启后没配 TOTP 的账号只能访问 /auth/*,
 * 也就是"除了去把 2FA 配上,别的什么都干不了"。
 *
 * 只拦网页会话,不拦 Bearer Token:脚本没法做 TOTP,一刀切会在开启开关的
 * 那一刻打断所有自动化。这不留后门 —— 建 Token 本身要走会话,已经被拦住了,
 * 所以没开 2FA 的人开启后无法再签发新 Token。存量 Token 仍然有效,
 * 需要收口的话在「账号安全」里逐个吊销。
 *
 * 返回 403 + code:'2fa_required',前端据此弹强制配置引导而不是当成普通报错。
 *
 * 注意这个开关会把开启它的管理员一起挡住(故意的 —— 只约束别人的安全策略
 * 没有意义),而 /api/settings 也在拦截范围内,所以开了之后不能靠面板再关掉。
 * 正常出路是照着引导把自己的 TOTP 配上;真的丢了验证器,改
 * data/settings.json 里的 require2FA 为 false 再重启面板。
 */
function requireTwoFactor(req, res, next) {
  if (!require('./settings').get().require2FA) return next();
  if (req.user.viaToken) return next();
  if (req.path.startsWith('/auth/')) return next();
  const user = users.find((u) => u.username === req.user.username);
  if (user && user.totp && user.totp.enabled) return next();
  return res.status(403).json({
    ok: false, code: '2fa_required',
    error: '管理员已要求所有账号启用两步验证,请先在「账号安全」中完成配置',
  });
}

/** 创建会话并返回 token(密码登录与 OAuth 登录共用) */
function createSession(username, req) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, {
    username,
    createdAt: Date.now(),
    lastSeen: Date.now(),
    // 记下来是为了让用户在"活跃会话"里认出哪台是自己,而不是面对一串随机 token
    ip: (req && req.ip) || '',
    ua: String((req && req.headers['user-agent']) || '').slice(0, 200),
  });
  saveSessions();
  return token;
}

function dropUserSessions(username) {
  for (const [token, sess] of sessions) if (sess.username === username) sessions.delete(token);
  saveSessions();
}

/* 每小时清一次过期会话 —— 原来只在访问到某个 token 时才惰性清理,
   长期不用的会话会一直躺在 sessions.json 里 */
setInterval(() => {
  let n = 0;
  for (const [token, s2] of [...sessions]) {
    if (Date.now() - s2.createdAt > SESSION_TTL_MS) { sessions.delete(token); n++; }
  }
  if (n) saveSessions();
}, 3600_000).unref();

/* ── /api/auth 路由 ── */

const router = express.Router();

/* ── 邀请注册(功能 10)。这两个端点必须免鉴权:用的人还没有账号 ── */

/** 查邀请是否可用,给注册页决定显示表单还是错误 */
router.get('/invite/:token', (req, res) => {
  const r = require('./invites').check(req.params.token);
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  res.json({ ok: true, invitedBy: r.invite.createdBy, note: r.invite.note, expiresAt: r.invite.expiresAt });
});

router.post('/invite/:token', (req, res) => {
  const invites = require('./invites');
  const r = invites.check(req.params.token);
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  const { username, password } = req.body || {};
  if (!username || !/^[\w.-]{2,24}$/.test(username)) return res.status(400).json({ ok: false, error: '用户名需为 2-24 位字母数字' });
  if (!password || String(password).length < 6) return res.status(400).json({ ok: false, error: '密码至少 6 位' });
  if (users.find((u) => u.username === username)) return res.status(409).json({ ok: false, error: '用户名已存在' });
  users.push({
    username,
    password: hashPassword(String(password)),
    role: 'user',                       // 邀请永远只能建普通用户
    createdAt: Date.now(),
    limits: r.invite.limits || undefined,
    invitedBy: r.invite.createdBy,
  });
  saveUsers();
  // 先建号再核销:反过来的话建号失败会白白烧掉一个邀请
  invites.consume(req.params.token, username);
  const token = createSession(username, req);
  res.setHeader('Set-Cookie', `mcsp_session=${token}; HttpOnly; Path=/; Max-Age=${7 * 86400}; SameSite=Lax`);
  res.json({ ok: true, user: { username, role: 'user' } });
});

router.post('/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const attempt = loginAttempts.get(ip);
  if (attempt && attempt.until > Date.now()) {
    return res.status(429).json({ ok: false, error: '尝试次数过多,请 1 分钟后再试' });
  }
  const { username, password } = req.body || {};
  const user = users.find((u) => u.username === username);
  if (!user || !verifyPassword(String(password || ''), user.password)) {
    const a = loginAttempts.get(ip) || { count: 0, until: 0 };
    a.count += 1;
    if (a.count >= 5) { a.until = Date.now() + 60000; a.count = 0; }
    loginAttempts.set(ip, a);
    saveAttempts();
    return res.status(401).json({ ok: false, error: '用户名或密码错误' });
  }
  // 2FA:密码对了还不够。验证码错误同样计入限速,否则第二道门可以无限暴力
  if (user.totp && user.totp.enabled) {
    const { code } = req.body || {};
    const clean = String(code || '').replace(/[\s-]/g, '');
    const byCode = clean && totp.verify(user.totp.secret, clean);
    const recIdx = clean ? (user.totp.recovery || []).findIndex((c) => c.replace(/-/g, '') === clean.toUpperCase()) : -1;
    if (!byCode && recIdx < 0) {
      const a2 = loginAttempts.get(ip) || { count: 0, until: 0 };
      a2.count += 1;
      if (a2.count >= 5) { a2.until = Date.now() + 60000; a2.count = 0; }
      loginAttempts.set(ip, a2);
      saveAttempts();
      return res.status(401).json({ ok: false, need2fa: true, error: clean ? '验证码不正确' : '需要两步验证码' });
    }
    // 恢复码一次性 —— 用过就作废,否则它就是一个永久的旁路口令
    if (recIdx >= 0) {
      user.totp.recovery.splice(recIdx, 1);
      saveUsers();
    }
  }

  loginAttempts.delete(ip);
  saveAttempts();
  const token = createSession(user.username, req);
  res.setHeader('Set-Cookie', `mcsp_session=${token}; HttpOnly; Path=/; Max-Age=${7 * 86400}; SameSite=Lax`);
  res.json({ ok: true, user: { username: user.username, role: user.role, defaultPassword: !!user.defaultPassword } });
});

/* 探测某用户是否需要 2FA —— 登录页据此决定要不要显示验证码输入框。
   有意对不存在的用户也返回 false 而不是报错:否则这就成了用户名枚举接口。 */
router.post('/needs-2fa', (req, res) => {
  const u = users.find((x) => x.username === (req.body || {}).username);
  res.json({ ok: true, need2fa: !!(u && u.totp && u.totp.enabled) });
});

router.post('/logout', (req, res) => {
  const token = parseCookies(req).mcsp_session;
  if (token) { sessions.delete(token); saveSessions(); }
  res.setHeader('Set-Cookie', 'mcsp_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const user = users.find((u) => u.username === req.user.username);
  res.json({ ok: true, user: {
    username: user.username, role: user.role,
    defaultPassword: !!user.defaultPassword,
    twoFactor: !!(user.totp && user.totp.enabled),
    // 前端据这两项决定要不要弹强制配置引导
    require2FA: !!require('./settings').get().require2FA,
    viaToken: !!req.user.viaToken,
  },
  /* 上传参数下发给前端。chunkMB 在这儿只是"要不要走分片"的判断依据;
     真正切片必须用 init 响应里的 chunkSize —— 配置在页面加载之后被改过的话,
     照这份旧值切出来的片会每一片都被判长度不符 */
  upload: {
    chunkMB: UPLOAD_CHUNK_MB,
    concurrency: UPLOAD_CONCURRENCY,
    maxUploadMB: MAX_UPLOAD_MB,
  } });
});

/* ── E3:两步验证(TOTP)── */

/** 第一步:生成密钥并返回,此时还没启用 */
router.post('/2fa/setup', requireAuth, (req, res) => {
  if (req.user.viaToken) return res.status(403).json({ ok: false, error: '请用网页登录后再配置两步验证' });
  const user = users.find((u) => u.username === req.user.username);
  if (user.totp && user.totp.enabled) return res.status(400).json({ ok: false, error: '已经启用了两步验证' });
  const secret = totp.generateSecret();
  user.totp = { enabled: false, secret, recovery: [] };
  saveUsers();
  res.json({ ok: true, secret, otpauth: totp.otpauthUrl(secret, user.username) });
});

/** 第二步:输入一次正确的码来确认 App 配好了,这时才真正启用并发恢复码 */
router.post('/2fa/enable', requireAuth, (req, res) => {
  const user = users.find((u) => u.username === req.user.username);
  if (!user.totp || !user.totp.secret) return res.status(400).json({ ok: false, error: '请先生成密钥' });
  if (user.totp.enabled) return res.status(400).json({ ok: false, error: '已经启用了' });
  if (!totp.verify(user.totp.secret, (req.body || {}).code)) {
    return res.status(400).json({ ok: false, error: '验证码不正确,请检查手机时间是否准确' });
  }
  user.totp.enabled = true;
  user.totp.recovery = totp.generateRecoveryCodes();
  saveUsers();
  // 恢复码也只在这里出现一次
  res.json({ ok: true, recovery: user.totp.recovery });
});

/** 关闭要验密码 —— 否则谁摸到一个没锁屏的浏览器就能把这道锁拆了 */
router.post('/2fa/disable', requireAuth, (req, res) => {
  const user = users.find((u) => u.username === req.user.username);
  if (!verifyPassword(String((req.body || {}).password || ''), user.password)) {
    return res.status(400).json({ ok: false, error: '密码不正确' });
  }
  // 强制开关开着的时候关掉自己的 2FA,是通往同一个死锁的另一扇门:
  // 关完下一个请求就会被 requireTwoFactor 拦住,而系统设置页也打不开,
  // 没法再去关那个开关。先关策略,再关自己的 2FA。
  if (require('./settings').get().require2FA) {
    return res.status(400).json({
      ok: false, code: 'policy_2fa_required',
      error: '面板已开启「强制两步验证」,不能关闭自己的 TOTP。请先在系统设置里关掉该策略。',
    });
  }
  user.totp = { enabled: false, secret: '', recovery: [] };
  saveUsers();
  res.json({ ok: true });
});

router.get('/2fa', requireAuth, (req, res) => {
  const user = users.find((u) => u.username === req.user.username);
  res.json({
    ok: true,
    enabled: !!(user.totp && user.totp.enabled),
    recoveryLeft: ((user.totp && user.totp.recovery) || []).length,
  });
});

router.put('/password', requireAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  const user = users.find((u) => u.username === req.user.username);
  if (!verifyPassword(String(oldPassword || ''), user.password)) {
    return res.status(400).json({ ok: false, error: '当前密码不正确' });
  }
  if (!newPassword || String(newPassword).length < 6) {
    return res.status(400).json({ ok: false, error: '新密码至少 6 位' });
  }
  user.password = hashPassword(String(newPassword));
  user.defaultPassword = false;
  saveUsers();
  res.json({ ok: true });
});

/* ── E4:活跃会话(自己的)—— 看得见哪台设备在线,并能踢掉 ── */

router.get('/sessions', requireAuth, (req, res) => {
  const mine = [...sessions]
    .filter(([, s2]) => s2.username === req.user.username)
    .map(([token, s2]) => ({
      id: token.slice(0, 12),               // 只回前缀,完整 token 不该再出现在响应里
      current: token === req.user.token,
      createdAt: s2.createdAt,
      lastSeen: s2.lastSeen || s2.createdAt,
      ip: s2.ip || '',
      ua: s2.ua || '',
    }))
    .sort((a, b) => b.lastSeen - a.lastSeen);
  res.json({ ok: true, sessions: mine });
});

router.delete('/sessions/:id', requireAuth, (req, res) => {
  const id = String(req.params.id);
  let killed = 0;
  for (const [token, s2] of [...sessions]) {
    if (s2.username !== req.user.username) continue;      // 只能踢自己的
    if (!token.startsWith(id)) continue;
    sessions.delete(token);
    killed++;
  }
  if (!killed) return res.status(404).json({ ok: false, error: '会话不存在' });
  saveSessions();
  res.json({ ok: true, killed });
});

/* 退出其它所有设备 —— 密码疑似泄露时最想点的那个按钮 */
router.post('/sessions/revoke-others', requireAuth, (req, res) => {
  let killed = 0;
  for (const [token, s2] of [...sessions]) {
    if (s2.username === req.user.username && token !== req.user.token) { sessions.delete(token); killed++; }
  }
  saveSessions();
  res.json({ ok: true, killed });
});

/* ── E2:API Token ── */

router.get('/tokens', requireAuth, (req, res) => {
  const user = users.find((u) => u.username === req.user.username);
  res.json({
    ok: true,
    tokens: (user.tokens || []).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsed: t.lastUsed || null })),
  });
});

router.post('/tokens', requireAuth, (req, res) => {
  const user = users.find((u) => u.username === req.user.username);
  // 用 token 本身去创建新 token 会让一次泄露自我延续,挡掉
  if (req.user.viaToken) return res.status(403).json({ ok: false, error: '请用网页登录后再创建 Token' });
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40) || '未命名';
  user.tokens = user.tokens || [];
  if (user.tokens.length >= 10) return res.status(400).json({ ok: false, error: '最多 10 个 Token' });
  const raw = 'mcsp_' + crypto.randomBytes(24).toString('base64url');
  const t = { id: crypto.randomUUID().slice(0, 8), name, hash: hashToken(raw), createdAt: Date.now(), lastUsed: null };
  user.tokens.push(t);
  saveUsers();
  // 明文只在这里出现这一次
  res.json({ ok: true, token: raw, id: t.id, name });
});

router.delete('/tokens/:id', requireAuth, (req, res) => {
  const user = users.find((u) => u.username === req.user.username);
  const before = (user.tokens || []).length;
  user.tokens = (user.tokens || []).filter((t) => t.id !== req.params.id);
  if (user.tokens.length === before) return res.status(404).json({ ok: false, error: 'Token 不存在' });
  saveUsers();
  res.json({ ok: true });
});

module.exports = {
  users, saveUsers, hashPassword, verifyPassword,
  getSession, requireAuth, requireAdmin, requireTwoFactor, dropUserSessions, createSession,
  router,
};
