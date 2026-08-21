/** /api/instances — 实例 CRUD 与全部实例级子资源 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { DATA_DIR, BACKUPS_DIR } = require('../config');
const { asyncHandler, dirSize } = require('../utils');
const { users: authUsers } = require('../auth');
const { Instance } = require('../instance');
const { instances, saveRegistry, installInstance } = require('../registry');
const { ensureAuthlibInjector } = require('../authlib');
const { TYPES } = require('../servertypes');
const { store: taskStore, saveTasks, taskScheduleText, runTask } = require('../tasks');
const { backupDir, listBackups, createBackup, restoreBackup } = require('../backups');
const { mcPing } = require('../mcping');
const bus = require('../bus');

const router = express.Router();

/* ── 路径沙箱与文本白名单 ── */

function safePath(inst, rel) {
  const p = path.resolve(inst.dir, '.' + path.sep + String(rel || '/').replace(/^\/+/, ''));
  if (p !== inst.dir && !p.startsWith(inst.dir + path.sep)) return null;
  return p;
}

const TEXT_EXT = new Set(['.txt', '.properties', '.yml', '.yaml', '.json', '.json5', '.toml', '.conf', '.cfg', '.ini', '.log', '.sh', '.md', '.mcmeta', '.snbt']);

/* :iid 统一解析;非管理员只能访问自己的实例(404 不泄露存在性) */
router.param('iid', (req, res, next, iid) => {
  const inst = instances.get(iid);
  if (!inst || (req.user.role !== 'admin' && inst.owner !== req.user.username)) {
    return res.status(404).json({ ok: false, error: '实例不存在' });
  }
  req.inst = inst;
  next();
});

/** 当前用户可见的实例:管理员全量,普通用户仅自己名下 */
const visibleInstances = (req) =>
  [...instances.values()].filter((i) => req.user.role === 'admin' || i.owner === req.user.username);

/** 普通用户的配额检查;extraMB 为本次新增的内存需求(排除 excludeInst 自身占用) */
function quotaError(req, extraMB, newInstance, excludeInst) {
  if (req.user.role === 'admin') return null;
  const u = authUsers.find((x) => x.username === req.user.username);
  const lim = (u && u.limits) || { maxInstances: 0, maxMemMB: 0 };
  const mine = [...instances.values()].filter((i) => i.owner === req.user.username);
  if (newInstance && mine.length >= lim.maxInstances) return `实例数已达配额上限(${lim.maxInstances} 个)`;
  const used = mine.reduce((s, i) => s + (excludeInst && i.id === excludeInst.id ? 0 : i.xmx), 0);
  if (used + extraMB > lim.maxMemMB) return `内存配额不足:已用 ${used} MB + 本次 ${extraMB} MB > 配额 ${lim.maxMemMB} MB`;
  return null;
}

/* ── CRUD ── */

router.get('/', (req, res) => {
  res.json(visibleInstances(req).map((i) => i.snapshot()));
});

/* 创建实例:普通用户也可以,但受资源配额约束(实例数/内存);实例归创建者所有 */
router.post('/', (req, res) => {
  const { name, type, version, port, gamemode, icon, xmx, eula } = req.body || {};
  const stype = TYPES[type] ? type : 'paper';
  if (!name || !String(name).trim()) return res.status(400).json({ ok: false, error: '实例名称不能为空' });
  // 代理(Velocity/Bungee)不含 Mojang 服务端,无需 EULA
  if (TYPES[stype].category === 'server' && !eula) return res.status(400).json({ ok: false, error: '必须同意 Minecraft EULA 才能安装服务端' });
  if (!version || !/^[A-Za-z0-9._-]{1,40}$/.test(version)) return res.status(400).json({ ok: false, error: '版本无效' });

  const xmxVal = Math.min(65536, Math.max(512, parseInt(xmx, 10) || 2048));
  const qerr = quotaError(req, xmxVal, true);
  if (qerr) return res.status(403).json({ ok: false, error: qerr });

  const id = crypto.randomUUID().slice(0, 8);
  const inst = new Instance({
    id,
    name: String(name).trim().slice(0, 40),
    owner: req.user.username,
    type: stype,
    version,
    jar: 'server.jar',
    xmx: xmxVal,
    icon: icon || '🌳',
    createdAt: Date.now(),
  });
  fs.mkdirSync(inst.dir, { recursive: true });
  instances.set(id, inst);
  saveRegistry();
  bus.broadcast('instances', {});
  res.json({ ok: true, instance: inst.snapshot() });

  // 下载安装异步进行,进度经 SSE 推送
  installInstance(inst, {
    port: parseInt(port, 10) || 25565 + instances.size - 1,
    gamemode: ['survival', 'creative', 'adventure', 'spectator'].includes(gamemode) ? gamemode : 'survival',
  });
});

/* 实例配置调整:内存上限 / 外置登录(运行中修改重启后生效;普通用户受内存配额约束) */
router.patch('/:iid', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const body = req.body || {};

  if (body.xmx !== undefined) {
    const mb = parseInt(body.xmx, 10);
    if (!Number.isFinite(mb)) return res.status(400).json({ ok: false, error: 'xmx 无效' });
    if (mb < 512 || mb > 65536) return res.status(400).json({ ok: false, error: '内存上限需在 512 ~ 65536 MB 之间' });
    const qerr = quotaError(req, mb, false, inst);
    if (qerr) return res.status(403).json({ ok: false, error: qerr });
    if (mb !== inst.xmx) {
      inst.xmx = mb;
      inst.metrics.ramMax = mb;
      inst.log('INFO', `[MCSP] 内存上限已调整为 ${mb} MB` + (inst.state === 'running' ? ' (重启后生效)' : ''));
    }
  }

  if (body.yggdrasil !== undefined) {
    const y = body.yggdrasil || {};
    const enabled = !!y.enabled;
    const url = String(y.url || '').trim().slice(0, 256);
    if (enabled) {
      if (!/^https?:\/\/[^\s"'\\]+$/.test(url)) {
        return res.status(400).json({ ok: false, error: 'Yggdrasil API 地址无效,需为 http(s) URL,如 https://littleskin.cn/api/yggdrasil' });
      }
      try {
        await ensureAuthlibInjector();
      } catch (err) {
        return res.status(502).json({ ok: false, error: `authlib-injector 下载失败: ${err.message}` });
      }
    }
    const changed = enabled !== inst.yggdrasil.enabled || url !== inst.yggdrasil.url;
    inst.yggdrasil = { enabled, url };
    if (changed) {
      inst.log('INFO', `[MCSP] 外置登录已${enabled ? `启用 (${url})` : '关闭'}` + (inst.state === 'running' ? ' (重启后生效)' : ''));
    }
  }

  saveRegistry();
  inst.emitState();
  res.json({ ok: true, instance: inst.snapshot() });
}));

/* 删除实例:实例主人或管理员(param 层已做归属校验) */
router.delete('/:iid', asyncHandler(async (req, res) => {
  const inst = req.inst;
  if (inst.state !== 'stopped') return res.status(400).json({ ok: false, error: '请先停止实例再删除' });
  if (inst.tunnelProc) inst.stopTunnel();
  fs.rmSync(path.join(DATA_DIR, `frpc-${inst.id}.toml`), { force: true });
  fs.rmSync(path.join(DATA_DIR, `playit-${inst.id}.toml`), { force: true });
  instances.delete(inst.id);
  taskStore.tasks = taskStore.tasks.filter((t) => t.iid !== inst.id);
  saveTasks();
  saveRegistry();
  await fsp.rm(inst.dir, { recursive: true, force: true });
  await fsp.rm(path.join(BACKUPS_DIR, inst.id), { recursive: true, force: true });
  bus.broadcast('instances', {});
  res.json({ ok: true });
}));

/* ── 状态 / 日志 / 指标 / 进程控制 / 命令 ── */

router.get('/:iid/status', (req, res) => res.json(req.inst.snapshot()));
router.get('/:iid/logs', (req, res) => res.json(req.inst.logs.slice(-300)));
router.get('/:iid/metrics/history', (req, res) => res.json(req.inst.metricsHistory));

router.post('/:iid/server/:action', (req, res) => {
  const inst = req.inst;
  const fn = { start: () => inst.start(), stop: () => inst.stop(), restart: () => inst.restart(), kill: () => inst.kill() }[req.params.action];
  if (!fn) return res.status(400).json({ ok: false, error: '未知操作' });
  res.json(fn());
});

router.post('/:iid/command', (req, res) => {
  const { command } = req.body || {};
  if (typeof command !== 'string') return res.status(400).json({ ok: false, error: '缺少 command 字段' });
  res.json(req.inst.command(command));
});

/* ── 玩家:实时解析 + 服务端自己的 JSON 文件 ── */

router.get('/:iid/players', (req, res) => {
  const inst = req.inst;
  res.json({
    online: inst.playerList(),
    banned: inst.readServerJson('banned-players.json').map((b) => b.name),
    whitelist: inst.readServerJson('whitelist.json').map((w) => w.name),
    ops: inst.readServerJson('ops.json').map((o) => o.name),
  });
});

router.post('/:iid/players/:name/:action', (req, res) => {
  const { name, action } = req.params;
  if (!/^[\w.-]{1,16}$/.test(name)) return res.status(400).json({ ok: false, error: '玩家名非法' });
  const map = {
    kick: `kick ${name}`,
    ban: `ban ${name}`,
    pardon: `pardon ${name}`,
    op: `op ${name}`,
    deop: `deop ${name}`,
    'whitelist-add': `whitelist add ${name}`,
    'whitelist-remove': `whitelist remove ${name}`,
  };
  if (!map[action]) return res.status(400).json({ ok: false, error: '未知操作' });
  res.json(req.inst.command(map[action]));
});

/* ── 世界 ── */

router.get('/:iid/worlds', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const levelName = inst.getProp('level-name') || 'world';
  const out = [];
  for (const suffix of ['', '_nether', '_the_end']) {
    const dir = path.join(inst.dir, levelName + suffix);
    if (!fs.existsSync(dir)) continue;
    out.push({
      name: levelName + suffix,
      env: suffix === '' ? 'normal' : suffix === '_nether' ? 'nether' : 'the_end',
      sizeMB: +((await dirSize(dir)) / 1048576).toFixed(1),
    });
  }
  res.json(out);
}));

router.post('/:iid/worlds/:name/:action', (req, res) => {
  const { value } = req.body || {};
  if (req.params.action === 'time') return res.json(req.inst.command(`time set ${String(value).replace(/[^\w]/g, '')}`));
  if (req.params.action === 'weather') return res.json(req.inst.command(`weather ${String(value).replace(/[^\w]/g, '')}`));
  return res.status(400).json({ ok: false, error: '未知操作' });
});

/* ── 插件:真实 jar,开关 = 重命名 .disabled ── */

router.get('/:iid/plugins', (req, res) => {
  const dir = path.join(req.inst.dir, 'plugins');
  let out = [];
  try {
    out = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        const enabled = f.endsWith('.jar');
        return {
          id: f,
          name: f.replace(/\.jar(\.disabled)?$/, ''),
          enabled,
          sizeMB: +(st.size / 1048576).toFixed(2),
          mtime: st.mtimeMs,
        };
      });
  } catch {}
  res.json(out);
});

router.post('/:iid/plugins/:id/toggle', (req, res) => {
  const inst = req.inst;
  const dir = path.join(inst.dir, 'plugins');
  const file = req.params.id;
  if (/[/\\]/.test(file)) return res.status(400).json({ ok: false, error: '非法文件名' });
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: '插件不存在' });
  const target = file.endsWith('.disabled') ? p.replace(/\.disabled$/, '') : p + '.disabled';
  fs.renameSync(p, target);
  const enabled = !file.endsWith('.disabled');
  inst.log('INFO', `[MCSP] 插件 ${path.basename(target)} 已${enabled ? '禁用' : '启用'} (重启后生效)`);
  res.json({ ok: true, plugin: { name: path.basename(target), enabled: !enabled } });
});

/* ── 备份 ── */

router.get('/:iid/backups', (req, res) => res.json(listBackups(req.inst)));

router.post('/:iid/backups', asyncHandler(async (req, res) => {
  const r = await createBackup(req.inst, req.body && req.body.name);
  res.json(r.ok ? { ok: true, backups: listBackups(req.inst) } : r);
}));

router.post('/:iid/backups/:id/restore', asyncHandler(async (req, res) => {
  if (req.inst.state !== 'stopped') return res.json({ ok: false, error: '请先停止实例再恢复备份' });
  res.json(await restoreBackup(req.inst, req.params.id));
}));

router.delete('/:iid/backups/:id', (req, res) => {
  const file = path.join(backupDir(req.inst), req.params.id);
  if (!fs.existsSync(file) || !req.params.id.endsWith('.tar.gz')) return res.status(404).json({ ok: false, error: '备份不存在' });
  fs.unlinkSync(file);
  req.inst.log('INFO', `[MCSP] 已删除备份 ${req.params.id}`);
  res.json({ ok: true });
});

/* ── server.properties ── */

router.get('/:iid/properties', (req, res) => res.json(req.inst.readProps()));

router.put('/:iid/properties', (req, res) => {
  const inst = req.inst;
  const props = inst.readProps();
  for (const [k, v] of Object.entries(req.body || {})) {
    if (/^[\w.-]+$/.test(k)) props[k] = String(v).replace(/[\r\n]/g, '');
  }
  inst.writeProps(props);
  inst.log('INFO', '[MCSP] server.properties 已保存' + (inst.state === 'running' ? ' (重启后生效)' : ''));
  res.json({ ok: true, properties: props });
});

/* ── 文件管理器:真实文件系统,路径沙箱 ── */

router.get('/:iid/files', asyncHandler(async (req, res) => {
  const p = safePath(req.inst, req.query.path);
  if (!p) return res.status(400).json({ ok: false, error: '非法路径' });
  let entries;
  try { entries = await fsp.readdir(p, { withFileTypes: true }); }
  catch { return res.status(404).json({ ok: false, error: '目录不存在' }); }
  const out = [];
  for (const e of entries) {
    let st;
    try { st = await fsp.stat(path.join(p, e.name)); } catch { continue; }
    const isText = TEXT_EXT.has(path.extname(e.name).toLowerCase());
    out.push({
      name: e.name,
      type: e.isDirectory() ? 'dir' : 'file',
      size: st.size,
      binary: !e.isDirectory() && (!isText || st.size > 2 * 1048576),
      mtime: st.mtimeMs,
    });
  }
  out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  res.json({ ok: true, path: req.query.path || '/', entries: out });
}));

router.get('/:iid/files/content', asyncHandler(async (req, res) => {
  const p = safePath(req.inst, req.query.path);
  if (!p) return res.status(400).json({ ok: false, error: '非法路径' });
  try {
    const st = await fsp.stat(p);
    if (!st.isFile()) return res.status(400).json({ ok: false, error: '不是文件' });
    if (st.size > 2 * 1048576) return res.status(400).json({ ok: false, error: '文件超过 2MB,无法在线编辑' });
    if (!TEXT_EXT.has(path.extname(p).toLowerCase())) return res.status(400).json({ ok: false, error: '二进制文件无法在线编辑' });
    res.json({ ok: true, content: await fsp.readFile(p, 'utf8') });
  } catch {
    res.status(404).json({ ok: false, error: '文件不存在' });
  }
}));

router.put('/:iid/files/content', asyncHandler(async (req, res) => {
  const { path: rel, content } = req.body || {};
  const p = safePath(req.inst, rel);
  if (!p) return res.status(400).json({ ok: false, error: '非法路径' });
  if (!TEXT_EXT.has(path.extname(p).toLowerCase())) return res.status(400).json({ ok: false, error: '只能编辑文本文件' });
  await fsp.writeFile(p, String(content || ''));
  req.inst.log('INFO', `[MCSP] 文件已保存: ${rel}`);
  if (path.basename(p) === 'server.properties') req.inst.invalidatePropsCache();
  res.json({ ok: true });
}));

router.post('/:iid/files/create', asyncHandler(async (req, res) => {
  const { dir, name, type } = req.body || {};
  if (!name || /[/\\]/.test(name) || name === '..') return res.status(400).json({ ok: false, error: '名称非法' });
  const parent = safePath(req.inst, dir);
  if (!parent) return res.status(400).json({ ok: false, error: '非法路径' });
  const p = path.join(parent, name);
  if (fs.existsSync(p)) return res.status(409).json({ ok: false, error: '同名文件已存在' });
  if (type === 'dir') await fsp.mkdir(p, { recursive: true });
  else await fsp.writeFile(p, '');
  res.json({ ok: true });
}));

router.delete('/:iid/files', asyncHandler(async (req, res) => {
  const p = safePath(req.inst, req.query.path);
  if (!p || p === req.inst.dir) return res.status(400).json({ ok: false, error: '非法路径' });
  await fsp.rm(p, { recursive: true, force: true });
  req.inst.log('INFO', `[MCSP] 已删除: ${req.query.path}`);
  res.json({ ok: true });
}));

/* ── 计划任务 ── */

router.get('/:iid/tasks', (req, res) => {
  res.json(taskStore.tasks.filter((t) => t.iid === req.inst.id).map((t) => ({ ...t, scheduleText: taskScheduleText(t) })));
});

router.post('/:iid/tasks', (req, res) => {
  const inst = req.inst;
  const { name, action, payload, schedule } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ ok: false, error: '任务名称不能为空' });
  if (!['restart', 'backup', 'command', 'start', 'stop'].includes(action)) return res.status(400).json({ ok: false, error: '未知任务类型' });
  let sched;
  if (schedule && schedule.type === 'interval' && +schedule.minutes >= 1) {
    sched = { type: 'interval', minutes: Math.floor(+schedule.minutes) };
  } else if (schedule && schedule.type === 'daily' && /^\d{2}:\d{2}$/.test(schedule.time || '')) {
    sched = { type: 'daily', time: schedule.time };
  } else {
    return res.status(400).json({ ok: false, error: '调度配置无效' });
  }
  const task = {
    id: crypto.randomUUID(),
    iid: inst.id,
    name: String(name).trim().slice(0, 40),
    action,
    payload: action === 'command' ? String(payload || '').slice(0, 200) : null,
    schedule: sched,
    enabled: true,
    lastRun: null,
    createdAt: Date.now(),
  };
  taskStore.tasks.push(task);
  saveTasks();
  inst.log('INFO', `[MCSP] 计划任务 "${task.name}" 已创建 (${taskScheduleText(task)})`);
  res.json({ ok: true, task });
});

router.post('/:iid/tasks/:id/toggle', (req, res) => {
  const task = taskStore.tasks.find((t) => t.id === req.params.id && t.iid === req.params.iid);
  if (!task) return res.status(404).json({ ok: false, error: '任务不存在' });
  task.enabled = !task.enabled;
  saveTasks();
  res.json({ ok: true, task });
});

router.post('/:iid/tasks/:id/run', asyncHandler(async (req, res) => {
  const task = taskStore.tasks.find((t) => t.id === req.params.id && t.iid === req.params.iid);
  if (!task) return res.status(404).json({ ok: false, error: '任务不存在' });
  await runTask(task);
  res.json({ ok: true });
}));

router.delete('/:iid/tasks/:id', (req, res) => {
  const i = taskStore.tasks.findIndex((t) => t.id === req.params.id && t.iid === req.params.iid);
  if (i === -1) return res.status(404).json({ ok: false, error: '任务不存在' });
  taskStore.tasks.splice(i, 1);
  saveTasks();
  res.json({ ok: true });
});

/* ── 实例级隧道 ── */

router.get('/:iid/tunnel', (req, res) => {
  const inst = req.inst;
  res.json({ ok: true, config: inst.tunnel, state: inst.tunnelState, addr: inst.tunnelAddr, error: inst.tunnelError, claim: inst.tunnelClaim });
});

router.put('/:iid/tunnel', (req, res) => {
  const inst = req.inst;
  const { type, ngrok, frpc, bore, pinggy, serveo } = req.body || {};
  if (!['none', 'ngrok', 'frpc', 'playit', 'bore', 'pinggy', 'serveo'].includes(type)) {
    return res.status(400).json({ ok: false, error: '类型无效' });
  }
  inst.tunnel = {
    type,
    ngrok: { authtoken: String((ngrok && ngrok.authtoken) || '').replace(/[^\w-]/g, '').slice(0, 80) },
    frpc: {
      serverAddr: String((frpc && frpc.serverAddr) || '').replace(/[^\w.:-]/g, '').slice(0, 128),
      serverPort: Math.min(65535, Math.max(1, parseInt(frpc && frpc.serverPort, 10) || 7000)),
      token: String((frpc && frpc.token) || '').replace(/["\\\r\n]/g, '').slice(0, 128),
      user: String((frpc && frpc.user) || '').replace(/["\\\r\n]/g, '').slice(0, 64),
      metaToken: String((frpc && frpc.metaToken) || '').replace(/["\\\r\n]/g, '').slice(0, 128),
      remotePort: Math.min(65535, Math.max(0, parseInt(frpc && frpc.remotePort, 10) || 0)),
    },
    playit: {},
    bore: {
      server: String((bore && bore.server) || 'bore.pub').replace(/[^\w.:-]/g, '').slice(0, 128) || 'bore.pub',
      secret: String((bore && bore.secret) || '').replace(/[^\w.-]/g, '').slice(0, 128),
      remotePort: Math.min(65535, Math.max(0, parseInt(bore && bore.remotePort, 10) || 0)),
    },
    pinggy: { token: String((pinggy && pinggy.token) || '').replace(/[^\w+-]/g, '').slice(0, 80) },
    serveo: { remotePort: Math.min(65535, Math.max(0, parseInt(serveo && serveo.remotePort, 10) || 0)) },
  };
  saveRegistry();
  inst.log('INFO', `[MCSP] 穿透配置已保存 (${type === 'none' ? '不启用' : type})${inst.tunnelProc ? ',重启隧道后生效' : ''}`);
  res.json({ ok: true, config: inst.tunnel });
});

router.post('/:iid/tunnel/start', (req, res) => res.json(req.inst.startTunnel()));
router.post('/:iid/tunnel/stop', (req, res) => res.json(req.inst.stopTunnel()));

router.post('/:iid/tunnel/check', asyncHandler(async (req, res) => {
  const inst = req.inst;
  if (!inst.tunnelAddr) return res.json({ ok: false, error: '隧道未建立或无公网地址' });
  const [host, portStr] = inst.tunnelAddr.split(':');
  const r = await mcPing(host, parseInt(portStr, 10) || 25565);
  if (r.ok) inst.log('INFO', `[MCSP] ✔ 公网连通性验证通过: ${inst.tunnelAddr}${r.version ? ' (' + r.version + ')' : ''}`);
  else inst.log('WARN', `[MCSP] ✘ 公网连通性验证失败: ${inst.tunnelAddr} — ${r.error}`);
  res.json({ ok: true, reachable: r.ok, version: r.version || null, error: r.error || null });
}));

module.exports = router;
