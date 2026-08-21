/**
 * 认证与用户:scrypt 哈希、HttpOnly Cookie 会话(持久化到磁盘,
 * 面板重启不掉线)、登录限速、双角色中间件。
 */
const crypto = require('crypto');
const express = require('express');
const { USERS_FILE, SESSIONS_FILE, SESSION_TTL_MS } = require('./config');
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

const loginAttempts = new Map(); // ip -> { count, until }

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
  return { token, username: user.username, role: user.role };
}

function requireAuth(req, res, next) {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ ok: false, error: '未登录或会话已过期' });
  req.user = sess;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ ok: false, error: '需要管理员权限' });
  next();
}

/** 创建会话并返回 token(密码登录与 OAuth 登录共用) */
function createSession(username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, createdAt: Date.now() });
  saveSessions();
  return token;
}

function dropUserSessions(username) {
  for (const [token, sess] of sessions) if (sess.username === username) sessions.delete(token);
  saveSessions();
}

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
    return res.status(401).json({ ok: false, error: '用户名或密码错误' });
  }
  loginAttempts.delete(ip);
  const token = createSession(user.username);
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

module.exports = {
  users, saveUsers, hashPassword, verifyPassword,
  getSession, requireAuth, requireAdmin, dropUserSessions, createSession,
  router,
};
