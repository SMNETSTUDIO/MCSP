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
const { githubLatestTag } = require('../utils');
const { version: PANEL_VERSION } = require('../../package.json');

/* 更新检查缓存 1 小时 —— 每次打开总览都去请求 GitHub 既慢又容易被限流 */
let updateCache = { at: 0, latest: null };
const UPDATE_TTL_MS = 3600_000;

/** 语义化版本比较:a 比 b 新返回 true。非数字段按 0 处理,够用了 */
function isNewer(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

const router = express.Router();

/* 宿主机硬件/系统信息只给管理员:主机名、CPU 型号、内核版本、负载、总内存、
   Node 版本、整机磁盘这些是运维视角的东西,泄给租户既没用又多一份指纹。
   普通用户仍拿得到面板版本与"自己看得见的实例"的计数和磁盘占用。 */
router.get('/host', asyncHandler(async (req, res) => {
  const isAdmin = req.user.role === 'admin';
  // 实例计数只统计当前用户可见的(普通用户之间互相隔离)
  const visible = [...instances.values()].filter((i) => i.canAccess(req.user));
  const body = {
    isAdmin,
    panelVersion: PANEL_VERSION,
    panelUptime: Date.now() - PANEL_STARTED,
    instanceCount: visible.length,
    runningCount: visible.filter((i) => i.state === 'running').length,
    // 谁在吃磁盘 —— 只列当前用户看得见的实例
    instanceDisk: visible
      .map((i) => ({ id: i.id, name: i.name, icon: i.icon, ...disk.instanceUsage(i.id) }))
      .sort((a, b) => b.totalMB - a.totalMB),
  };
  if (isAdmin) {
    const cpus = os.cpus();
    Object.assign(body, {
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      cpuModel: cpus[0] ? cpus[0].model : 'unknown',
      cores: cpus.length,
      loadavg: os.loadavg().map((n) => +n.toFixed(2)),
      totalMem: Math.round(os.totalmem() / 1048576),
      freeMem: Math.round(os.freemem() / 1048576),
      nodeVersion: process.version,
      javaVersion: java.bestJavaVersionLine(),
      java: java.javaInfo(),
      disk: await disk.hostDisk(),
    });
  }
  res.json(body);
}));

/* 更新检查。?force=1 跳过缓存(用户点「检查更新」时用)。
   拿不到就如实说"查不到",不要假装是最新版 —— 那比不查更糟。 */
router.get('/version', asyncHandler(async (req, res) => {
  const fresh = req.query.force === '1' || Date.now() - updateCache.at > UPDATE_TTL_MS;
  if (fresh) {
    const latest = await githubLatestTag('SMNETSTUDIO/MCSP', null);
    updateCache = { at: Date.now(), latest };
  }
  const latest = updateCache.latest;
  res.json({
    ok: true,
    current: PANEL_VERSION,
    latest,
    hasUpdate: !!latest && isNewer(latest, PANEL_VERSION),
    checkedAt: updateCache.at,
    url: 'https://github.com/SMNETSTUDIO/MCSP/releases',
  });
}));

/* Java 运行时:状态查询 + 一键安装全部缺失版本。
   查询也要管理员 —— 装了哪些 JRE、装在哪、宿主机什么架构,同样是宿主机信息 */
router.get('/java', requireAdmin, (req, res) => res.json(java.javaInfo()));

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
