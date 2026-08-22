/**
 * 认证与用户:scrypt 哈希、HttpOnly Cookie 会话(持久化到磁盘,
 * 面板重启不掉线)、登录限速、双角色中间件。
 */
const crypto = require('crypto');
const express = require('express');
const path = require('path');
const { USERS_FILE, SESSIONS_FILE, SESSION_TTL_MS, DATA_DIR } = require('./config');
const { readJson, writeJson } = require('./utils');

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
  loginAttempts.delete(ip);
  saveAttempts();
  const token = createSession(user.username, req);
  res.setHeader('Set-Cookie', `mcsp_session=${token}; HttpOnly; Path=/; Max-Age=${7 * 86400}; SameSite=Lax`);
  res.json({ ok: true, user: { username: user.username, role: user.role, defaultPassword: !!user.defaultPassword } });
});

router.post('/logout', (req, res) => {
  const token = parseCookies(req).mcsp_session;
  if (token) { sessions.delete(token); saveSessions(); }
  res.setHeader('Set-Cookie', 'mcsp_session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

router.get('/me', requireAuth, (req, res) => {
  const user = users.find((u) => u.username === req.user.username);
  res.json({ ok: true, user: { username: user.username, role: user.role, defaultPassword: !!user.defaultPassword } });
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
  getSession, requireAuth, requireAdmin, dropUserSessions, createSession,
  router,
};
