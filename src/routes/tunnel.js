/** /api/tunnel/components — 穿透组件安装(实例级隧道路由在 instances.js) */
const express = require('express');
const { requireAdmin } = require('../auth');
const { asyncHandler } = require('../utils');
const { componentInfo, installComponent } = require('../tunnels');

const router = express.Router();

router.get('/components', (req, res) => res.json(componentInfo()));

router.post('/components/:name/install', requireAdmin, asyncHandler(async (req, res) => {
  const { name } = req.params;
  if (!['ngrok', 'frpc', 'playit', 'bore'].includes(name)) return res.status(400).json({ ok: false, error: '未知组件' });
  try {
    await installComponent(name);
    res.json({ ok: true, components: componentInfo() });
  } catch (err) {
    res.json({ ok: false, error: `安装失败: ${err.message}` });
  }
}));

module.exports = router;
