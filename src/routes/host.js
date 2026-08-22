/** /api/host、/api/paper、/api/java — 宿主机信息、Paper 版本列表、Java 运行时 */
const os = require('os');
const express = require('express');
const { PANEL_STARTED } = require('../config');
const { asyncHandler } = require('../utils');
const { requireAdmin } = require('../auth');
const { instances } = require('../registry');
const { listTypes, typeVersions, TYPES } = require('../servertypes');
const java = require('../java');
const disk = require('../disk');

const router = express.Router();

router.get('/host', asyncHandler(async (req, res) => {
  const cpus = os.cpus();
  const javaVersion = java.bestJavaVersionLine();
  // 实例计数只统计当前用户可见的(普通用户之间互相隔离)
  const visible = [...instances.values()].filter((i) => req.user.role === 'admin' || i.owner === req.user.username);
  res.json({
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: cpus[0] ? cpus[0].model : 'unknown',
    cores: cpus.length,
    loadavg: os.loadavg().map((n) => +n.toFixed(2)),
    totalMem: Math.round(os.totalmem() / 1048576),
    freeMem: Math.round(os.freemem() / 1048576),
    nodeVersion: process.version,
    javaVersion,
    java: java.javaInfo(),
    panelUptime: Date.now() - PANEL_STARTED,
    instanceCount: visible.length,
    runningCount: visible.filter((i) => i.state === 'running').length,
    disk: await disk.hostDisk(),
    // 谁在吃磁盘 —— 只列当前用户看得见的实例
    instanceDisk: visible
      .map((i) => ({ id: i.id, name: i.name, icon: i.icon, ...disk.instanceUsage(i.id) }))
      .sort((a, b) => b.totalMB - a.totalMB),
  });
}));

/* Java 运行时:状态查询 + 一键安装全部缺失版本 */
router.get('/java', (req, res) => res.json(java.javaInfo()));

router.post('/java/install', requireAdmin, asyncHandler(async (req, res) => {
  try {
    res.json({ ok: true, java: await java.installAllJava() });
  } catch (err) {
    res.json({ ok: false, error: `安装失败: ${err.message}`, java: java.javaInfo() });
  }
}));

/* 服务端类型列表与各类型可用版本 */
router.get('/servertypes', (req, res) => res.json({ ok: true, types: listTypes() }));

router.get('/servertypes/:type/versions', asyncHandler(async (req, res) => {
  if (!TYPES[req.params.type]) return res.status(400).json({ ok: false, error: '未知服务端类型' });
  try {
    res.json({ ok: true, versions: await typeVersions(req.params.type) });
  } catch (err) {
    res.json({ ok: false, error: err.message, versions: [] });
  }
}));

/* 兼容旧接口(smoke 测试与旧前端使用) */
router.get('/paper/versions', asyncHandler(async (req, res) => {
  try {
    res.json({ ok: true, versions: await typeVersions('paper') });
  } catch (err) {
    res.json({ ok: false, error: err.message, versions: ['1.21.8', '1.21.4', '1.20.6'] });
  }
}));

module.exports = router;
