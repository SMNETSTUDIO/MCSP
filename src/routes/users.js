/** /api/users — 用户管理(仅管理员):账户 CRUD + 资源配额(实例数/内存/CPU 核数) */
const os = require('os');
const express = require('express');
const { users, saveUsers, hashPassword, requireAdmin, dropUserSessions } = require('../auth');
const { instances } = require('../registry');

const router = express.Router();
router.use(requireAdmin);

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 普通用户的资源配额(管理员不受限) */
function sanitizeLimits(l) {
  l = l || {};
  return {
    maxInstances: clamp(parseInt(l.maxInstances, 10) || 1, 1, 12),
    maxMemMB: clamp(parseInt(l.maxMemMB, 10) || 2048, 512, 65536),
    maxCpuCores: clamp(parseInt(l.maxCpuCores, 10) || 2, 1, os.cpus().length),
  };
}

/** 某用户当前占用:实例数与内存(xmx 之和) */
function usageOf(username) {
  const mine = [...instances.values()].filter((i) => i.owner === username);
  return { instances: mine.length, memMB: mine.reduce((s, i) => s + i.xmx, 0) };
}

router.get('/', (req, res) => {
  res.json(users.map((u) => ({
    username: u.username,
    role: u.role,
    createdAt: u.createdAt,
    defaultPassword: !!u.defaultPassword,
    oauth: !!u.oauthId,
    oauthName: u.oauthName || null,
    limits: u.role === 'admin' ? null : sanitizeLimits(u.limits),
    usage: usageOf(u.username),
  })));
});

router.post('/', (req, res) => {
  const { username, password, role, limits } = req.body || {};
  if (!username || !/^[\w.-]{2,24}$/.test(username)) return res.status(400).json({ ok: false, error: '用户名需为 2-24 位字母数字' });
  if (!password || String(password).length < 6) return res.status(400).json({ ok: false, error: '密码至少 6 位' });
  if (users.some((u) => u.username === username)) return res.status(409).json({ ok: false, error: '用户名已存在' });
  const isAdmin = role === 'admin';
  users.push({
    username,
    password: hashPassword(String(password)),
    role: isAdmin ? 'admin' : 'user',
    createdAt: Date.now(),
    ...(isAdmin ? {} : { limits: sanitizeLimits(limits) }),
  });
  saveUsers();
  res.json({ ok: true });
});

/* 调整普通用户的资源配额(不影响已在运行的实例,重启后生效) */
router.put('/:name/limits', (req, res) => {
  const user = users.find((u) => u.username === req.params.name);
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
  if (user.role === 'admin') return res.status(400).json({ ok: false, error: '管理员不受配额限制' });
  user.limits = sanitizeLimits(req.body);
  saveUsers();
  res.json({ ok: true, limits: user.limits });
});

router.delete('/:name', (req, res) => {
  const { name } = req.params;
  if (name === req.user.username) return res.status(400).json({ ok: false, error: '不能删除自己' });
  const i = users.findIndex((u) => u.username === name);
  if (i === -1) return res.status(404).json({ ok: false, error: '用户不存在' });
  if (usageOf(name).instances > 0) return res.status(400).json({ ok: false, error: '该用户还有实例,请先删除其全部实例' });
  users.splice(i, 1);
  dropUserSessions(name);
  saveUsers();
  res.json({ ok: true });
});

router.put('/:name/password', (req, res) => {
  const user = users.find((u) => u.username === req.params.name);
  if (!user) return res.status(404).json({ ok: false, error: '用户不存在' });
  const { password } = req.body || {};
  if (!password || String(password).length < 6) return res.status(400).json({ ok: false, error: '密码至少 6 位' });
  user.password = hashPassword(String(password));
  user.defaultPassword = false;
  saveUsers();
  res.json({ ok: true });
});

module.exports = { router, sanitizeLimits };
