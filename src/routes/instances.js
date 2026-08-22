/** /api/instances — 实例 CRUD 与全部实例级子资源 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { DATA_DIR, BACKUPS_DIR, MAX_UPLOAD_MB, MAX_EXTRACT_MB } = require('../config');
const { asyncHandler, dirSize } = require('../utils');
const { archiveKind, extractArchive, createArchive } = require('../archive');
const disk = require('../disk');
const modrinth = require('../modrinth');
const { users: authUsers } = require('../auth');
const { Instance, sanitizeJvmArgs } = require('../instance');
const { instances, saveRegistry, installInstance, reinstallInstance, cloneInstance } = require('../registry');
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

/** 单段文件名校验:不允许分隔符、`.`/`..`,以及 NUL 等控制字符 */
const isSafeName = (name) =>
  !!name && name.length <= 255 && !/[/\\]/.test(name) && !/[\x00-\x1f]/.test(name) && name !== '.' && name !== '..';

/* 备份 id 必须是单段 tar.gz 文件名 —— :id 会被 Express 解码,
   不校验的话 `..%2F..%2F` 能带着 path.join 走出 backups/ 目录 */
const isBackupId = (id) => /^[\w.-]+\.tar\.gz$/.test(id);

/**
 * 把请求体原样落到 dest(不引 multipart 依赖:前端一次传一个文件,
 * body 就是文件本身)。超过 max 字节立即掐断,返回已写入字节数。
 */
function receiveUpload(req, dest, max) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest);
    let received = 0;
    let failed = null;
    const fail = (err) => {
      if (failed) return;
      failed = err;
      req.unpipe(ws);
      ws.destroy();
      reject(err);
    };
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > max) fail(Object.assign(new Error('文件超过上传大小上限'), { tooLarge: true }));
    });
    req.on('aborted', () => fail(new Error('上传中断')));
    req.on('error', fail);
    ws.on('error', fail);
    ws.on('finish', () => { if (!failed) resolve(received); });
    req.pipe(ws);
  });
}

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

/**
 * 普通用户的磁盘配额:还能再写多少 MB(Infinity = 不限)。
 * 数字来自 disk.js 的后台缓存,所以每个写入路径成功后都要 disk.bump() 把
 * 增量立刻记回去 —— 否则用户能在两次扫描之间连传十几个大文件,每次读到的
 * 都是同一个"还没超"的旧数字。
 */
function diskRemainingMB(req) {
  if (req.user.role === 'admin') return Infinity;
  const u = authUsers.find((x) => x.username === req.user.username);
  const max = u && u.limits ? u.limits.maxDiskMB : 0;
  if (!max) return Infinity;                       // 0 / 未设置 = 不限
  return Math.max(0, max - disk.userUsageMB(req.user.username));
}

/** 需要 needMB 空间时的报错文案;够用返回 null */
function diskQuotaError(req, needMB) {
  const left = diskRemainingMB(req);
  if (left === Infinity || needMB <= left) return null;
  const u = authUsers.find((x) => x.username === req.user.username);
  return `磁盘配额不足:本次约需 ${needMB.toFixed(0)} MB,剩余 ${left.toFixed(0)} MB(配额 ${u.limits.maxDiskMB} MB)`;
}

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
  disk.refresh(id);          // 立刻纳入磁盘统计,别等下一轮后台扫描才开始算配额
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

  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 40);
    if (!name) return res.status(400).json({ ok: false, error: '实例名称不能为空' });
    if (name !== inst.name) {
      inst.log('INFO', `[MCSP] 实例已改名: ${inst.name} → ${name}`);
      inst.name = name;
    }
  }

  if (body.icon !== undefined) {
    // 只是个显示用的 emoji,限长 + 挡掉控制字符就够,不必枚举白名单
    const icon = String(body.icon).replace(/[\x00-\x1f]/g, '').trim().slice(0, 8);
    if (icon) inst.icon = icon;
  }

  if (body.jvmArgs !== undefined) {
    const { error } = sanitizeJvmArgs(body.jvmArgs);
    if (error) return res.status(400).json({ ok: false, error });
    const text = String(body.jvmArgs).replace(/[\r\n]+/g, ' ').trim();
    if (text !== inst.jvmArgs) {
      inst.jvmArgs = text;
      inst.log('INFO', `[MCSP] JVM 参数已更新${text ? '' : '(已清空,恢复默认)'}` + (inst.state === 'running' ? ' (重启后生效)' : ''));
    }
  }

  if (body.autoRestart !== undefined) {
    const on = !!body.autoRestart;
    if (on !== inst.autoRestart) {
      inst.autoRestart = on;
      if (!on) inst.cancelAutoRestart();
      inst.log('INFO', `[MCSP] 崩溃自动重启已${on ? '开启' : '关闭'}`);
    }
  }

  if (body.autoStart !== undefined) {
    const on = !!body.autoStart;
    if (on !== inst.autoStart) {
      inst.autoStart = on;
      inst.log('INFO', `[MCSP] 面板重启后自动恢复已${on ? '开启' : '关闭'}`);
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

/* 克隆:复制整个实例目录,换 id / 名字 / 端口。受实例数、内存、磁盘三项配额约束。 */
router.post('/:iid/clone', asyncHandler(async (req, res) => {
  const src = req.inst;
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ ok: false, error: '新实例名称不能为空' });
  // 边跑边拷世界会拿到一份撕裂的存档,而且往往要等玩家进服才暴露
  if (src.state !== 'stopped') return res.status(400).json({ ok: false, error: '请先停止源实例再克隆' });

  const qerr = quotaError(req, src.xmx, true);
  if (qerr) return res.status(403).json({ ok: false, error: qerr });
  const dqerr = diskQuotaError(req, disk.instanceUsage(src.id).instMB);
  if (dqerr) return res.status(403).json({ ok: false, error: dqerr });

  const { inst, port } = await cloneInstance(src, { name, owner: req.user.username });
  disk.refresh(inst.id);
  if (!port) inst.log('WARN', '[MCSP] 没找到空闲端口,请手动修改 server-port 后再启动');
  res.json({ ok: true, instance: inst.snapshot(), port });
}));

/* 重装 / 升级:换服务端 jar,保留世界与全部配置。默认先自动备份一份。 */
router.post('/:iid/reinstall', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const { type, version, backup } = req.body || {};
  if (inst.state !== 'stopped') return res.status(400).json({ ok: false, error: '请先停止实例再重装' });

  const stype = TYPES[type] ? type : inst.type;
  if (!version || !/^[A-Za-z0-9._-]{1,40}$/.test(version)) return res.status(400).json({ ok: false, error: '版本无效' });
  if (stype === inst.type && version === inst.version) {
    return res.status(400).json({ ok: false, error: '目标类型与版本和当前一致,无需重装' });
  }
  // 代理换成服务端时才需要补 EULA —— 原本就是服务端的话创建时已经同意过
  const needEula = TYPES[stype].category === 'server' && !fs.existsSync(path.join(inst.dir, 'eula.txt'));
  if (needEula && !req.body.eula) {
    return res.status(400).json({ ok: false, error: '切换为服务端类型需要同意 Minecraft EULA' });
  }

  const withBackup = backup !== false;
  if (withBackup) {
    const dqerr = diskQuotaError(req, disk.instanceUsage(inst.id).instMB);
    if (dqerr) return res.status(403).json({ ok: false, error: `${dqerr} —— 可关闭「重装前自动备份」后重试` });
  }

  res.json({ ok: true });                       // 下载安装异步进行,进度经 SSE 推
  reinstallInstance(inst, { type: stype, version, backup: withBackup });
}));

/* 删除实例:实例主人或管理员(param 层已做归属校验) */
router.delete('/:iid', asyncHandler(async (req, res) => {
  const inst = req.inst;
  if (inst.state !== 'stopped') return res.status(400).json({ ok: false, error: '请先停止实例再删除' });
  inst.cancelAutoRestart();     // 否则实例都删了,几秒后那个定时器还会来拉一次
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
/**
 * 控制台日志。默认回最后 300 行(前端首屏),支持:
 *   ?q=关键词   大小写不敏感的子串匹配
 *   ?level=ERROR,WARN  只看这些级别
 *   ?limit=N    最多回多少行(上限就是缓冲区大小)
 * 过滤在整个缓冲区上做,而不是先截 300 行再过滤 —— 否则搜"半小时前那条报错"永远搜不到。
 */
function filterLogs(inst, { q, level, limit }) {
  let out = inst.logs;
  if (level) {
    const want = new Set(String(level).toUpperCase().split(',').map((x) => x.trim()).filter(Boolean));
    if (want.size) out = out.filter((l) => want.has(String(l.level).toUpperCase()));
  }
  if (q) {
    const needle = String(q).toLowerCase();
    out = out.filter((l) => l.message.toLowerCase().includes(needle));
  }
  const n = Math.min(inst.logs.length, Math.max(1, parseInt(limit, 10) || 300));
  return { total: out.length, lines: out.slice(-n) };
}

router.get('/:iid/logs', (req, res) => {
  const { q, level, limit } = req.query;
  // 没带任何查询参数时保持老行为(裸数组),前端首屏和冒烟用例都依赖它
  if (!q && !level && !limit) return res.json(req.inst.logs.slice(-300));
  res.json({ ok: true, buffered: req.inst.logs.length, ...filterLogs(req.inst, { q, level, limit }) });
});

/* 下载完整控制台缓冲为纯文本 —— 排查崩溃时要贴给别人看 */
router.get('/:iid/logs/download', (req, res) => {
  const inst = req.inst;
  const { lines } = filterLogs(inst, { q: req.query.q, level: req.query.level, limit: inst.logs.length });
  const body = lines.map((l) => `[${l.time}] [${l.level}] ${l.message}`).join('\n') + '\n';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ascii = `mcsp-${inst.id}-${stamp}.log`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(`${inst.name}-${stamp}.log`)}`);
  res.send(body);
});
/* ?range=day 给 24 小时的分钟级聚合(含峰值);默认仍是秒级实时曲线 */
router.get('/:iid/metrics/history', (req, res) => {
  if (req.query.range === 'day') {
    return res.json({ ok: true, range: 'day', points: req.inst.metricsMinutes });
  }
  res.json(req.inst.metricsHistory);
});

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

/* ── 插件 / 模组:真实 jar,开关 = 重命名 .disabled ──
   目录取 servertypes 里声明的 dataDir:Paper 系是 plugins/,Fabric/Forge/NeoForge 是 mods/,
   Vanilla 为 null(原版两者都不支持)。安装实例时 registry 就是按这个字段建的目录。 */

/** 扩展目录名与称呼;dataDir 为 null 时返回 null */
function extDir(inst) {
  const name = (TYPES[inst.type] || TYPES.paper).dataDir;
  if (!name) return null;
  return { name, kind: name === 'mods' ? 'mod' : 'plugin', noun: name === 'mods' ? '模组' : '插件' };
}

router.get('/:iid/plugins', (req, res) => {
  const ext = extDir(req.inst);
  if (!ext) return res.json({ ok: true, dir: null, kind: null, noun: null, items: [] });
  const dir = path.join(req.inst.dir, ext.name);
  let items = [];
  try {
    items = fs.readdirSync(dir)
      .filter((f) => f.endsWith('.jar') || f.endsWith('.jar.disabled'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return {
          id: f,
          name: f.replace(/\.jar(\.disabled)?$/, ''),
          enabled: f.endsWith('.jar'),
          sizeMB: +(st.size / 1048576).toFixed(2),
          mtime: st.mtimeMs,
        };
      });
  } catch {}
  res.json({ ok: true, dir: ext.name, kind: ext.kind, noun: ext.noun, items });
});

/* Modrinth 在线搜索 —— 按当前实例的 loader 与 MC 版本过滤,搜出来的都是装得上的 */
router.get('/:iid/plugins/search', asyncHandler(async (req, res) => {
  const inst = req.inst;
  if (!extDir(inst)) return res.status(400).json({ ok: false, error: '该服务端类型不支持插件或模组' });
  try {
    const r = await modrinth.search({ query: req.query.q, type: inst.type, version: inst.version });
    res.json({ ok: true, ...r });
  } catch (err) {
    res.status(502).json({ ok: false, error: `搜索失败: ${err.message}` });
  }
}));

router.get('/:iid/plugins/versions/:projectId', asyncHandler(async (req, res) => {
  const inst = req.inst;
  try {
    // 先按当前 MC 版本查;一个都没有时放宽版本,让用户自己判断要不要装
    let list = await modrinth.versions({ projectId: req.params.projectId, type: inst.type, version: inst.version });
    let exact = true;
    if (!list.length) {
      list = await modrinth.versions({ projectId: req.params.projectId, type: inst.type });
      exact = false;
    }
    res.json({ ok: true, exact, versions: list.slice(0, 20) });
  } catch (err) {
    res.status(502).json({ ok: false, error: `获取版本失败: ${err.message}` });
  }
}));

router.post('/:iid/plugins/install', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const ext = extDir(inst);
  if (!ext) return res.status(400).json({ ok: false, error: '该服务端类型不支持插件或模组' });
  const { projectId, versionId } = req.body || {};
  if (!projectId || !/^[\w-]{1,32}$/.test(String(projectId))) return res.status(400).json({ ok: false, error: '项目 ID 无效' });
  if (versionId && !/^[\w-]{1,32}$/.test(String(versionId))) return res.status(400).json({ ok: false, error: '版本 ID 无效' });

  const dqerr = diskQuotaError(req, 64);      // jar 一般几 MB,给个宽松的预检额度
  if (dqerr) return res.status(403).json({ ok: false, error: dqerr });

  try {
    const r = await modrinth.install({
      projectId, versionId, type: inst.type, version: inst.version,
      destDir: path.join(inst.dir, ext.name),
    });
    disk.bump(inst.id, r.size / 1048576);
    inst.log('INFO', `[MCSP] 已安装${ext.noun} ${r.filename} (${(r.size / 1048576).toFixed(1)} MB${r.verified ? ', SHA-1 校验通过' : ''})`
      + (inst.state === 'running' ? ',重启后生效' : ''));
    res.json({ ok: true, ...r, noun: ext.noun });
  } catch (err) {
    inst.log('ERROR', `[MCSP] 安装失败: ${err.message}`);
    res.status(502).json({ ok: false, error: err.message });
  }
}));

/* 删除插件/模组 —— 此前只能启停,想删得去文件管理器 */
router.delete('/:iid/plugins/:id', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const ext = extDir(inst);
  if (!ext) return res.status(400).json({ ok: false, error: '该服务端类型不支持插件或模组' });
  const file = req.params.id;
  if (!isSafeName(file) || !/\.jar(\.disabled)?$/i.test(file)) {
    return res.status(400).json({ ok: false, error: '非法文件名' });
  }
  const p = path.join(inst.dir, ext.name, file);
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: `${ext.noun}不存在` });
  await fsp.rm(p, { force: true });
  disk.refresh(inst.id);
  inst.log('INFO', `[MCSP] 已删除${ext.noun} ${file}` + (inst.state === 'running' ? ',重启后生效' : ''));
  res.json({ ok: true });
}));

router.post('/:iid/plugins/:id/toggle', (req, res) => {
  const inst = req.inst;
  const ext = extDir(inst);
  if (!ext) return res.status(400).json({ ok: false, error: '该服务端类型不支持插件或模组' });
  const file = req.params.id;
  if (/[/\\]/.test(file)) return res.status(400).json({ ok: false, error: '非法文件名' });
  const p = path.join(inst.dir, ext.name, file);
  if (!fs.existsSync(p)) return res.status(404).json({ ok: false, error: `${ext.noun}不存在` });
  const target = file.endsWith('.disabled') ? p.replace(/\.disabled$/, '') : p + '.disabled';
  fs.renameSync(p, target);
  const enabled = !file.endsWith('.disabled');
  inst.log('INFO', `[MCSP] ${ext.noun} ${path.basename(target)} 已${enabled ? '禁用' : '启用'} (重启后生效)`);
  res.json({ ok: true, plugin: { name: path.basename(target), enabled: !enabled } });
});

/* ── 备份 ── */

router.get('/:iid/backups', (req, res) => res.json(listBackups(req.inst)));

router.post('/:iid/backups', asyncHandler(async (req, res) => {
  // 备份是实例目录的 tar.gz,压完只会更小,拿目录体积做保守预检
  const dqerr = diskQuotaError(req, disk.instanceUsage(req.inst.id).instMB);
  if (dqerr) return res.status(403).json({ ok: false, error: dqerr });
  const r = await createBackup(req.inst, req.body && req.body.name);
  disk.refresh(req.inst.id);      // 保留策略可能顺手删了旧包,增量算不准,直接重算
  res.json(r.ok ? { ok: true, backups: listBackups(req.inst) } : r);
}));

router.post('/:iid/backups/:id/restore', asyncHandler(async (req, res) => {
  if (!isBackupId(req.params.id)) return res.status(404).json({ ok: false, error: '备份不存在' });
  if (req.inst.state !== 'stopped') return res.json({ ok: false, error: '请先停止实例再恢复备份' });
  res.json(await restoreBackup(req.inst, req.params.id));
}));

/* 下载备份:直接流式回传 tar.gz(Express 处理 Range / ETag) */
router.get('/:iid/backups/:id/download', (req, res) => {
  const id = req.params.id;
  if (!isBackupId(id)) return res.status(404).json({ ok: false, error: '备份不存在' });
  const file = path.join(backupDir(req.inst), id);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: '备份不存在' });
  res.download(file, id, (err) => {
    if (err && !res.headersSent) res.status(500).json({ ok: false, error: '下载失败' });
  });
});

router.delete('/:iid/backups/:id', (req, res) => {
  if (!isBackupId(req.params.id)) return res.status(404).json({ ok: false, error: '备份不存在' });
  const file = path.join(backupDir(req.inst), req.params.id);
  if (!fs.existsSync(file)) return res.status(404).json({ ok: false, error: '备份不存在' });
  fs.unlinkSync(file);
  disk.refresh(req.inst.id);
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

/* ── 常见配置文件的快捷入口 ── */

/* 只列"这个服务端类型真的会用到"的文件。故意不做成表单:
   这些 YAML 的键随服务端版本一直在变,硬编码字段迟早对不上,
   还不如把人直接送到已有的文本编辑器前面。 */
const KNOWN_CONFIGS = {
  server: [
    ['bukkit.yml', 'Bukkit 核心:生成上限、自动保存间隔'],
    ['spigot.yml', 'Spigot:实体活动范围、合并阈值、超时'],
    ['paper.yml', 'Paper(1.19 之前的旧版单文件配置)'],
    ['config/paper-global.yml', 'Paper 全局配置(1.19+)'],
    ['config/paper-world-defaults.yml', 'Paper 每世界默认值(1.19+)'],
    ['purpur.yml', 'Purpur 专有配置'],
    ['pufferfish.yml', 'Pufferfish 专有配置'],
    ['commands.yml', '命令别名'],
    ['permissions.yml', '权限组'],
    ['eula.txt', 'Minecraft EULA 同意状态'],
  ],
  proxy: [
    ['velocity.toml', 'Velocity 主配置'],
    ['forwarding.secret', 'Velocity 转发密钥'],
    ['config.yml', 'BungeeCord / Waterfall 主配置'],
  ],
};

router.get('/:iid/configs', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const t = TYPES[inst.type] || TYPES.paper;
  const out = [];
  const add = async (rel, desc) => {
    const p = safePath(inst, rel);
    if (!p) return;
    let st;
    try { st = await fsp.stat(p); } catch { return; }      // 不存在就不列,免得点开一片空文件
    if (!st.isFile()) return;
    out.push({ path: '/' + rel, name: path.basename(rel), desc, size: st.size, mtime: st.mtimeMs });
  };
  for (const [rel, desc] of KNOWN_CONFIGS[t.category] || []) await add(rel, desc);

  // Fabric/Forge 的模组配置都堆在 config/ 下,数量不定,扫一层
  if (t.dataDir === 'mods') {
    let entries = [];
    try { entries = await fsp.readdir(path.join(inst.dir, 'config'), { withFileTypes: true }); } catch {}
    for (const e of entries.slice(0, 60)) {
      if (e.isFile() && /\.(toml|json|json5|cfg|conf|properties|yml|yaml)$/i.test(e.name)) {
        await add(path.posix.join('config', e.name), '模组配置');
      }
    }
  }
  res.json({ ok: true, configs: out });
}));

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
      archive: !e.isDirectory() && !!archiveKind(e.name),
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

/* 下载:文件原样回传,目录现打包成 tar.gz 流式回传(不落盘) */
router.get('/:iid/files/download', asyncHandler(async (req, res) => {
  const p = safePath(req.inst, req.query.path);
  if (!p) return res.status(400).json({ ok: false, error: '非法路径' });
  // 整个实例目录交给备份功能:那条路会先 save-all 再打包,这里不重复实现
  if (p === req.inst.dir) return res.status(400).json({ ok: false, error: '整个实例请用「备份」页打包下载' });

  let st;
  try { st = await fsp.stat(p); } catch { return res.status(404).json({ ok: false, error: '文件不存在' }); }

  if (st.isFile()) {
    return res.download(p, path.basename(p), (err) => {
      if (err && !res.headersSent) res.status(500).json({ ok: false, error: '下载失败' });
    });
  }
  if (!st.isDirectory()) return res.status(400).json({ ok: false, error: '不支持的文件类型' });

  const base = path.basename(p);
  const archive = base + '.tar.gz';
  // 流式输出没有 Content-Length,文件名同时给 ASCII 兜底和 UTF-8 版本(世界目录常是中文)。
  // 纯中文名清洗完只剩下划线,那还不如给个能看的默认名。
  const ascii = (base.replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '') || 'folder') + '.tar.gz';
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition',
    `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(archive)}`);

  const tar = spawn('tar', ['czf', '-', '-C', path.dirname(p), base]);
  let stderr = '';
  tar.stderr.on('data', (d) => { stderr += d.toString().slice(0, 500); });
  tar.on('error', (err) => {
    req.inst.log('ERROR', `[MCSP] 打包下载失败: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ ok: false, error: `打包失败: ${err.message}` });
    else res.destroy();
  });
  tar.on('exit', (code) => {
    if (code === 0) return;
    // 头已经发出去了,只能断流让浏览器把这次下载判为失败
    req.inst.log('ERROR', `[MCSP] 打包下载失败 (tar exit ${code}) ${stderr.trim()}`);
    res.destroy();
  });
  // 客户端中途取消就别继续压缩了,否则一个大世界会白烧几分钟 CPU
  res.on('close', () => { if (tar.exitCode === null) tar.kill('SIGKILL'); });
  tar.stdout.pipe(res);
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

/* 上传:body = 文件原始字节,目标目录与文件名走 query;同名需显式 overwrite */
router.post('/:iid/files/upload', asyncHandler(async (req, res) => {
  const name = String(req.query.name || '');
  if (!isSafeName(name)) return res.status(400).json({ ok: false, error: '文件名非法' });

  const parent = safePath(req.inst, req.query.path);
  if (!parent) return res.status(400).json({ ok: false, error: '非法路径' });
  let pst;
  try { pst = await fsp.stat(parent); } catch { return res.status(404).json({ ok: false, error: '目录不存在' }); }
  if (!pst.isDirectory()) return res.status(400).json({ ok: false, error: '目标不是目录' });

  const dest = path.join(parent, name);
  const overwrite = req.query.overwrite === '1';
  if (fs.existsSync(dest)) {
    if (!overwrite) return res.status(409).json({ ok: false, error: '同名文件已存在' });
    if (fs.statSync(dest).isDirectory()) return res.status(409).json({ ok: false, error: '同名目录已存在' });
  }

  // 配额直接压进流式上限:超额时不用等收完整个文件再拒,写到界就断
  const quotaLeft = diskRemainingMB(req);
  const max = Math.min(MAX_UPLOAD_MB * 1048576, quotaLeft === Infinity ? Infinity : quotaLeft * 1048576);
  const declared = parseInt(req.headers['content-length'], 10);
  if (Number.isFinite(declared) && declared > max) {
    const qerr = diskQuotaError(req, declared / 1048576);
    return res.status(413).json({ ok: false, error: qerr || `文件超过上传大小上限 ${MAX_UPLOAD_MB} MB` });
  }

  // 先写临时文件再 rename:上传中断不会在目录里留下半截的同名文件
  const tmp = path.join(parent, `.mcsp-upload-${crypto.randomUUID().slice(0, 8)}`);
  let size;
  try {
    size = await receiveUpload(req, tmp, max);
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    if (err.tooLarge) {
      // 响应发出后直接断连:剩下的字节可能还有好几 GB,没必要收完再丢
      res.on('finish', () => req.destroy());
      const qerr = diskQuotaError(req, max / 1048576 + 1);
      return res.status(413).json({ ok: false, error: qerr || `文件超过上传大小上限 ${MAX_UPLOAD_MB} MB` });
    }
    if (res.headersSent || req.destroyed) return;   // 客户端自己断的,没人在等这个响应
    return res.status(400).json({ ok: false, error: `上传失败: ${err.message}` });
  }
  await fsp.rename(tmp, dest);

  disk.bump(req.inst.id, size / 1048576);
  const rel = path.posix.join(String(req.query.path || '/'), name);
  req.inst.log('INFO', `[MCSP] 已上传: ${rel} (${(size / 1048576).toFixed(2)} MB)`);
  if (name === 'server.properties') req.inst.invalidatePropsCache();
  res.json({ ok: true, name, size });
}));

router.delete('/:iid/files', asyncHandler(async (req, res) => {
  const p = safePath(req.inst, req.query.path);
  if (!p || p === req.inst.dir) return res.status(400).json({ ok: false, error: '非法路径' });
  await fsp.rm(p, { recursive: true, force: true });
  disk.refresh(req.inst.id);      // 删的可能是个大目录,不重算用户会被旧数字白白挡着
  req.inst.log('INFO', `[MCSP] 已删除: ${req.query.path}`);
  res.json({ ok: true });
}));

/* 重命名 / 同目录内改名(跨目录移动请用剪切板式操作,这里只改最后一段) */
router.post('/:iid/files/rename', asyncHandler(async (req, res) => {
  const { path: rel, name } = req.body || {};
  if (!isSafeName(name)) return res.status(400).json({ ok: false, error: '名称非法' });
  const src = safePath(req.inst, rel);
  if (!src || src === req.inst.dir) return res.status(400).json({ ok: false, error: '非法路径' });
  if (!fs.existsSync(src)) return res.status(404).json({ ok: false, error: '文件不存在' });
  const dest = path.join(path.dirname(src), name);
  if (dest === src) return res.json({ ok: true });
  if (fs.existsSync(dest)) return res.status(409).json({ ok: false, error: '同名文件已存在' });
  await fsp.rename(src, dest);
  req.inst.log('INFO', `[MCSP] 已重命名: ${rel} → ${name}`);
  if (path.basename(src) === 'server.properties' || name === 'server.properties') req.inst.invalidatePropsCache();
  res.json({ ok: true });
}));

/* ── 压缩包:解压 / 打包 ── */

/* 解压和打包都可能跑几分钟,同一实例只允许一个在跑:
   否则用户手抖点两下,两个 tar 会往同一个目录里对着写 */
const archiveBusy = new Set();

/** 解压 { path: 压缩包, dest: 目标目录(可不存在) } */
router.post('/:iid/files/extract', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const { path: rel, dest: destRel } = req.body || {};
  const src = safePath(inst, rel);
  if (!src) return res.status(400).json({ ok: false, error: '非法路径' });
  if (!archiveKind(src)) {
    return res.status(400).json({ ok: false, error: '不支持的格式,可解压 zip / mrpack / tar / tar.gz / tar.bz2 / tar.xz' });
  }
  let st;
  try { st = await fsp.stat(src); } catch { return res.status(404).json({ ok: false, error: '压缩包不存在' }); }
  if (!st.isFile()) return res.status(400).json({ ok: false, error: '不是文件' });

  const dest = safePath(inst, destRel || path.posix.dirname(String(rel)));
  if (!dest) return res.status(400).json({ ok: false, error: '非法的解压目标路径' });
  if (fs.existsSync(dest) && !fs.statSync(dest).isDirectory()) {
    return res.status(409).json({ ok: false, error: '解压目标已存在同名文件' });
  }

  if (archiveBusy.has(inst.id)) return res.status(409).json({ ok: false, error: '该实例已有压缩任务在进行中' });
  archiveBusy.add(inst.id);
  const shown = destRel || path.posix.dirname(String(rel));
  inst.log('INFO', `[MCSP] 开始解压 ${rel} → ${shown}`);
  try {
    await fsp.mkdir(dest, { recursive: true });
    const left = diskRemainingMB(req);
    const cap = Math.min(MAX_EXTRACT_MB * 1048576, left === Infinity ? Infinity : left * 1048576);
    const r = await extractArchive(src, dest, cap);
    disk.bump(inst.id, r.bytes / 1048576);
    inst.log('INFO', `[MCSP] 解压完成: ${rel} → ${shown} (${r.files} 个文件, ${(r.bytes / 1048576).toFixed(1)} MB)`);
    inst.invalidatePropsCache();      // 整合包/世界包里常带 server.properties
    res.json({ ok: true, ...r });
  } catch (err) {
    inst.log('ERROR', `[MCSP] 解压失败: ${rel} — ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  } finally {
    archiveBusy.delete(inst.id);
  }
}));

/** 打包 { dir: 所在目录, names: [单段名], name: 输出名, format: zip|tar.gz } */
router.post('/:iid/files/archive', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const { dir, names, name, format } = req.body || {};
  const fmt = format === 'tar.gz' ? 'tar.gz' : 'zip';

  const parent = safePath(inst, dir);
  if (!parent) return res.status(400).json({ ok: false, error: '非法路径' });
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    return res.status(404).json({ ok: false, error: '目录不存在' });
  }
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ ok: false, error: '未选择要打包的内容' });
  if (names.length > 2000) return res.status(400).json({ ok: false, error: '一次最多打包 2000 项' });
  for (const n of names) {
    if (!isSafeName(n)) return res.status(400).json({ ok: false, error: `名称非法: ${n}` });
    if (!fs.existsSync(path.join(parent, n))) return res.status(404).json({ ok: false, error: `不存在: ${n}` });
  }

  // 输出名:去掉用户可能已经带上的后缀,统一按所选格式补回去
  const stem = String(name || (names.length === 1 ? names[0] : 'archive'))
    .trim().replace(/\.(zip|tar\.gz|tgz|tar)$/i, '').slice(0, 200);
  const outName = stem + '.' + fmt;
  if (!isSafeName(outName)) return res.status(400).json({ ok: false, error: '压缩包名称非法' });
  const out = path.join(parent, outName);
  if (fs.existsSync(out)) return res.status(409).json({ ok: false, error: `${outName} 已存在` });

  // 压缩包不会比原始内容更大,拿输入体积做保守预检
  const inputMB = names.reduce((s, n) => {
    try { return s + fs.statSync(path.join(parent, n)).size / 1048576; } catch { return s; }
  }, 0);
  const dqerr = diskQuotaError(req, inputMB);
  if (dqerr) return res.status(403).json({ ok: false, error: dqerr });

  if (archiveBusy.has(inst.id)) return res.status(409).json({ ok: false, error: '该实例已有压缩任务在进行中' });
  archiveBusy.add(inst.id);
  // 先写到临时名再改回来:打包途中它不会被 tar 自己扫进去,中断也不会留下半个能点开的包
  const tmp = path.join(parent, `.mcsp-archive-${crypto.randomUUID().slice(0, 8)}`);
  inst.log('INFO', `[MCSP] 开始打包 ${names.length} 项 → ${outName}`);
  try {
    const r = await createArchive(tmp, parent, names, fmt);
    await fsp.rename(tmp, out);
    const size = (await fsp.stat(out)).size;
    disk.bump(inst.id, size / 1048576);
    inst.log('INFO', `[MCSP] 打包完成: ${outName} (${r.files} 个文件, ${(size / 1048576).toFixed(1)} MB)`);
    res.json({ ok: true, name: outName, files: r.files, size });
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    inst.log('ERROR', `[MCSP] 打包失败: ${outName} — ${err.message}`);
    res.status(400).json({ ok: false, error: err.message });
  } finally {
    archiveBusy.delete(inst.id);
  }
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
  const result = await runTask(task);
  res.json({ ok: true, result });
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
