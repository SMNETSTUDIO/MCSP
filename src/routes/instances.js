/** /api/instances — 实例 CRUD 与全部实例级子资源 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { DATA_DIR, BACKUPS_DIR, MAX_UPLOAD_MB, MAX_EXTRACT_MB, UPLOAD_CHUNK_MB } = require('../config');
const { asyncHandler, dirSize, memFootprintMB, memOverheadMB } = require('../utils');
const uploads = require('../uploads');
const { archiveKind, extractArchive, createArchive } = require('../archive');
const disk = require('../disk');
const playtime = require('../playtime');
const modrinth = require('../modrinth');
const rcon = require('../rcon');
const { users: authUsers } = require('../auth');
const { Instance, sanitizeJvmArgs, COLLAB_ROLES } = require('../instance');
const { instances, saveRegistry, installInstance, reinstallInstance, cloneInstance } = require('../registry');
const { ensureAuthlibInjector } = require('../authlib');
const { TYPES } = require('../servertypes');
const { detectServer, findServerRoot } = require('../detect');
const { store: taskStore, saveTasks, taskScheduleText, runTask } = require('../tasks');
const { backupDir, listBackups, createBackup, restoreBackup, inspectBackup } = require('../backups');
const { mcPing } = require('../mcping');
const bus = require('../bus');

const router = express.Router();

/* ── 路径沙箱与文本白名单 ── */

/* 实例根目录的 realpath 缓存。ROOT 本身可能落在软链下(/workspace 之类),
   所以比对必须是 realpath 对 realpath,不能拿原始路径去比。 */
const realDirCache = new Map();
function instRealDir(inst) {
  let real = realDirCache.get(inst.id);
  if (real === undefined) {
    try { real = fs.realpathSync(inst.dir); } catch { real = inst.dir; }
    realDirCache.set(inst.id, real);
  }
  return real;
}

/**
 * 把面板传来的相对路径解析成实例目录内的绝对路径,越界返回 null。
 *
 * 两道关:
 * 1. 词法 —— path.resolve 之后必须仍在 inst.dir 底下,挡掉 `..`;
 * 2. realpath —— 词法判断挡不住软链。实例目录里放一个 `etclink -> /etc`,
 *    `/etclink/hostname` 能干干净净通过第一关,然后 download/content/delete
 *    就在沙箱外操作了(实测可读出宿主机 /etc/hostname)。
 *
 * 目标路径可能还不存在(新建文件、上传目标、改名后的名字),所以往上找到
 * 第一个真实存在的祖先再解 —— 只要那个祖先在沙箱内,底下还没创建的部分
 * 自然也在沙箱内。
 */
function safePath(inst, rel) {
  const p = path.resolve(inst.dir, '.' + path.sep + String(rel || '/').replace(/^\/+/, ''));
  if (p !== inst.dir && !p.startsWith(inst.dir + path.sep)) return null;

  const root = instRealDir(inst);
  for (let probe = p; ;) {
    try {
      const real = fs.realpathSync(probe);
      return (real === root || real.startsWith(root + path.sep)) ? p : null;
    } catch (e) {
      if (e.code !== 'ENOENT') return null;      // EACCES/ELOOP 等一律当越界处理
      const parent = path.dirname(probe);
      if (parent === probe) return null;          // 走到文件系统根都没找到,不可能是沙箱内
      probe = parent;
    }
  }
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
 *
 * opts 直接透给 createWriteStream —— 分片上传要用 { flags:'r+', start: 偏移 }
 * 往同一个临时文件的指定区间写。这里刻意做成一个函数而不是复制一份:下面
 * fail() / unpipe / aborted 的处理很微妙,两份迟早会走样。
 */
function receiveUpload(req, dest, max, opts = undefined) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(dest, opts);
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

/* 半路拒绝上传时,剩下的请求体还在路上。
 *
 * 直接 req.destroy() 给对端的是一个 RST,而此刻反代正往这条连接里写 body ——
 * 它自己的转发请求当场失败,浏览器看到的就成了 502,我们精心写的那句
 * "超过上限 / 配额不足" 反而丢了。Cloudflare Worker 尤其如此:它转发时用的是
 * chunked(没有 Content-Length),走不到上面按 Content-Length 提前拒绝那条路,
 * 只会落到这里 —— 于是"传个十几 MB 的包就 502"。
 *
 * 所以先把余量吞掉,让 413 能顺着连接正常走完。吞的量有上限:真是几个 GB 的
 * 包就不陪它收完了,那时才断连(此时 413 已发出,反代多半也已转发出去)。
 */
const DRAIN_MAX_BYTES = 64 * 1048576;
const DRAIN_MAX_MS = 10_000;

function drainRequest(req, maxBytes = DRAIN_MAX_BYTES, maxMs = DRAIN_MAX_MS) {
  if (req.readableEnded || req.destroyed) return Promise.resolve(true);
  return new Promise((resolve) => {
    let dropped = 0;
    const done = (ok) => {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      resolve(ok);
    };
    const onData = (chunk) => { dropped += chunk.length; if (dropped > maxBytes) done(false); };
    const onEnd = () => done(true);
    const onError = () => done(false);
    const timer = setTimeout(() => done(false), maxMs);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.resume();
  });
}

/* :iid 统一解析;非管理员只能访问自己的实例(404 不泄露存在性) */
router.param('iid', (req, res, next, iid) => {
  const inst = instances.get(iid);
  if (!inst || !inst.canAccess(req.user)) {
    return res.status(404).json({ ok: false, error: '实例不存在' });
  }
  req.inst = inst;
  req.perm = inst.permOf(req.user);
  next();
});

/* ── 协作者权限档的执行(功能 8)──
 *
 * 61 条路由逐个标注权限太容易漏,而漏掉的那条会默认放行 —— 权限代码里
 * "忘了写"必须等于"拒绝",不能等于"允许"。所以这里反过来:
 * GET 一律 viewer 起,其余方法**默认要 manager**(= 协作者原本的能力),
 * 只有明确列进 OPERATOR_WRITES 的才降到 operator。
 *
 * 这个方向保证了两件事:
 *   · 新加路由默认落到 manager,不会因为没标注而对 viewer 敞开;
 *   · 老的字符串协作者被解释成 manager,升级后能做的事和以前一模一样。
 */
const LEVEL = { viewer: 1, operator: 2, manager: 3, owner: 4 };

/* 日常运维:启停、发命令、做备份。这些不改配置也不动文件,
   交给"能帮我看服但别乱改东西"的人正好 */
const OPERATOR_WRITES = [
  /* 启停的真实路由是 `/:iid/server/:action`,所以这里看到的 req.path 是
     `/server/start` 而不是 `/start`。原先写成 /^\/(start|…)$/ 永不匹配,
     启停于是被判成 manager —— 方向上是失效关闭(不越权),但 operator 档
     因此形同虚设:想给人启停权就只能给 manager,而 manager 能改文件改配置。
     净效果是权限被迫放大,也和 README 承诺的分档对不上。 */
  /^\/server\/(start|stop|restart|kill)$/,
  /^\/command$/,
  /^\/backups$/,
  /^\/players\/[^/]+\/(kick|ban|pardon|op|deop)$/,
  // 注:`/rcon` 只有 GET(GET 一律 viewer),写操作是 `/rcon/enable` ——
  // 那是往 server.properties 里写密码,属于改配置,留在 manager 是对的
];

/* 会读出**凭据或任意文件内容**的 GET,不能留在 viewer。
   README 承诺的 viewer 是「看状态·日志·玩家」,而这几条一旦放开:
     · /rcon        直接返回 rcon.password 明文
     · /properties  readProps() 把整个 server.properties 端出来(含 rcon.password)
     · /files/content /files/download  能读实例内任意文件,包括上面两个
       和 Velocity 的 forwarding.secret(configs 里就列着)
     · /backups/:id/download  一个归档 = 整个世界 + 全部配置 + 密钥
   等于"只读"档能把实例的全部秘密拿走。文件访问在 README 的分档里本来
   就属于 manager,这里只是让实现追上文档。 */
const MANAGER_READS = [
  /^\/rcon$/,
  /^\/properties$/,
  /^\/files\/content$/,
  /^\/files\/download$/,
  /^\/backups\/[^/]+\/download$/,
];

function requiredLevel(req) {
  // 挂在 '/:iid' 上的 use,Express 已经把 /api/instances/<iid> 剥掉了,
  // req.path 就是实例内的子路径('/server/start'、'/'…)。别再自己剥一次
  const sub = req.path || '/';
  if (req.method === 'GET' || req.method === 'HEAD') {
    return MANAGER_READS.some((re) => re.test(sub)) ? LEVEL.manager : LEVEL.viewer;
  }
  return OPERATOR_WRITES.some((re) => re.test(sub)) ? LEVEL.operator : LEVEL.manager;
}

/* ── 导入已有服务器 ──
 *
 * 分三步,因为要复用现成的上传接口(带进度条,大存档能传几个 G):
 *   1) POST /import                建一个空壳实例,拿到 iid
 *   2) 前端把压缩包传到 /:iid/files/upload(大文件自动走分片)
 *   3) POST /:iid/import/finalize  解压 → 认出类型和版本 → 落元数据
 *
 * 空壳实例的 state 是 importing,前端据此不显示启动按钮 —— 半个服务器被拉起来
 * 只会写坏存档。
 *
 * ⚠ 这条**必须**注册在下面那个 router.use('/:iid') 之前。Express 对 use() 层
 * 同样会跑 router.param('iid'),所以 /import 会被当成一个叫 "import" 的实例 ID
 * 去查,查不到就 404 —— 这个功能因此整整坏了一段时间,而且不报错、只是 404。
 * 以后再加**不带 :iid 的顶层子路由**,一律加在这里,别加到下面去。 */
router.post('/import', (req, res) => {
  const { name, icon, xmx } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ ok: false, error: '实例名称不能为空' });

  const xmxVal = Math.min(65536, Math.max(512, parseInt(xmx, 10) || 2048));
  const qerr = quotaError(req, xmxVal, true);
  if (qerr) return res.status(403).json({ ok: false, error: qerr });

  const id = crypto.randomUUID().slice(0, 8);
  const inst = new Instance({
    id,
    name: String(name).trim().slice(0, 40),
    owner: req.user.username,
    type: 'vanilla',                 // 占位,finalize 时按探测结果改写
    version: '',
    jar: 'server.jar',
    xmx: xmxVal,
    icon: icon || '🧭',
    createdAt: Date.now(),
  });
  fs.mkdirSync(inst.dir, { recursive: true });
  inst.state = 'importing';
  instances.set(id, inst);
  disk.refresh(id);
  saveRegistry();
  bus.broadcast('instances', {});
  inst.log('INFO', '[MCSP] 已建立空实例,等待上传服务器压缩包…');
  res.json({ ok: true, instance: inst.snapshot() });
});

router.use('/:iid', (req, res, next) => {
  const have = LEVEL[req.perm] || 0;
  const need = requiredLevel(req);
  if (have >= need) return next();
  const label = { 1: '只读', 2: '运维', 3: '管理' }[need] || '管理';
  return res.status(403).json({
    ok: false, code: 'insufficient_perm',
    error: `权限不足:该操作需要「${label}」及以上,你在这个实例上是「${{ viewer: '只读', operator: '运维', manager: '管理' }[req.perm] || req.perm}」`,
  });
});

/** 当前用户可见的实例:管理员全量,普通用户仅自己名下 */
const visibleInstances = (req) => [...instances.values()].filter((i) => i.canAccess(req.user));

/** 主人或管理员 —— 删实例、改协作者这类"所有权级"操作用它,协作者不够格 */
const isOwnerOrAdmin = (req, inst) => req.user.role === 'admin' || inst.owner === req.user.username;

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

/**
 * 普通用户的配额检查;extraMB 为本次新增的**堆**上限(排除 excludeInst 自身占用)。
 *
 * 内存一律按 memFootprintMB 折算,也就是堆 + 堆外余量,而不是裸 -Xmx ——
 * 配额要防的是宿主机内存被排满,而 JVM 向宿主机要的从来不止堆那一块。
 * 按 Σ-Xmx 排满的结果是 OOM killer 半夜随机挑一个服务端杀掉。
 */
function quotaError(req, extraMB, newInstance, excludeInst) {
  if (req.user.role === 'admin') return null;
  const u = authUsers.find((x) => x.username === req.user.username);
  const lim = (u && u.limits) || { maxInstances: 0, maxMemMB: 0 };
  const mine = [...instances.values()].filter((i) => i.owner === req.user.username);
  if (newInstance && mine.length >= lim.maxInstances) return `实例数已达配额上限(${lim.maxInstances} 个)`;
  const used = mine.reduce((s, i) => s + (excludeInst && i.id === excludeInst.id ? 0 : memFootprintMB(i.xmx)), 0);
  const over = memOverheadMB(extraMB);
  if (used + extraMB + over > lim.maxMemMB) {
    /* 把堆和堆外拆开写。合成一个 "本次 4608 MB" 会让填了 4096 的人以为面板算错了,
       而这恰恰是最需要解释清楚的一次 —— 用户就是在这里第一次撞见这个口径 */
    return `内存配额不足:已用 ${used} MB + 本次 ${extraMB} MB(另需堆外 ${over} MB)> 配额 ${lim.maxMemMB} MB`;
  }
  return null;
}

/* ── CRUD ── */

router.get('/', (req, res) => {
  /* perm 加在路由层而不是 snapshot() 里:同一份 snapshot 还会经 SSE 广播给
     权限不同的多个用户,把 perm 塞进去就会发错人。这里按**请求者**逐个算。 */
  res.json(visibleInstances(req).map((i) => ({ ...i.snapshot(), perm: i.permOf(req.user) })));
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
    // installInstance 支持 motd,之前调用方没传,那个参数一直是 undefined(死参数)。
    // 前端也没有对应输入框,所以这里给个和实例同名的默认值,把链路接上
    motd: String(name).trim().slice(0, 59),
  });
});

/** 解压上传上来的包并认出这是个什么服务端 { archive: '/xxx.zip' } */
router.post('/:iid/import/finalize', asyncHandler(async (req, res) => {
  const inst = req.inst;
  if (inst.state !== 'importing') return res.status(409).json({ ok: false, error: '该实例不处于导入状态' });

  const src = safePath(inst, (req.body || {}).archive);
  if (!src) return res.status(400).json({ ok: false, error: '非法路径' });
  if (!fs.existsSync(src)) return res.status(404).json({ ok: false, error: '压缩包不存在' });
  if (!archiveKind(src)) return res.status(400).json({ ok: false, error: '不支持的压缩格式' });

  if (archiveBusy.has(inst.id)) return res.status(409).json({ ok: false, error: '该实例已有压缩任务在进行中' });
  archiveBusy.add(inst.id);
  try {
    const left = diskRemainingMB(req);
    const cap = Math.min(MAX_EXTRACT_MB * 1048576, left === Infinity ? Infinity : left * 1048576);
    inst.log('INFO', '[MCSP] 正在解压…');
    const out = await extractArchive(src, inst.dir, cap);
    await fsp.rm(src, { force: true });                 // 包本身不留在实例里白占配额
    disk.bump(inst.id, out.bytes / 1048576);

    /* 压缩包常常多套一层目录(server.zip 里是 server/…)。把真正的服务器根
       整体提上来,否则实例目录里只有一个孤零零的子文件夹,启动脚本全找不到 */
    const root = findServerRoot(inst.dir);
    if (root !== inst.dir) {
      inst.log('INFO', `[MCSP] 压缩包多套了一层目录,正在展平: ${path.basename(root)}/`);
      for (const name of await fsp.readdir(root)) {
        await fsp.rename(path.join(root, name), path.join(inst.dir, name)).catch(() => {});
      }
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }

    const d = detectServer(inst.dir);
    if (d.type) inst.type = d.type;
    if (d.version) inst.version = d.version;
    if (d.jar) inst.jar = d.jar;

    /* 用户在导入表单里勾了 EULA 就补上 —— 从没跑过的服务端包没有 eula.txt,
       否则启动时只会在日志深处留一行 "Failed to load eula.txt" */
    if ((req.body || {}).eula) {
      const eulaFile = path.join(inst.dir, 'eula.txt');
      if (!fs.existsSync(eulaFile) || !/eula\s*=\s*true/i.test(fs.readFileSync(eulaFile, 'utf8'))) {
        fs.writeFileSync(eulaFile, `# Accepted via MCSP by panel user on ${new Date().toISOString()}\neula=true\n`);
        d.notes = d.notes.filter((n) => !n.includes('eula.txt'));
        inst.log('INFO', '[MCSP] 已写入 eula=true');
      }
    }
    inst.state = 'stopped';
    inst.invalidatePropsCache();
    saveRegistry();
    bus.broadcast('instances', {});

    const label = (TYPES[inst.type] || {}).label || inst.type;
    inst.log('INFO', `[MCSP] 导入完成: ${label} ${inst.version || '(版本未知)'} · ${out.files} 个文件`);
    for (const n of d.notes) inst.log('WARN', `[MCSP] ${n}`);
    inst.emitState();
    res.json({ ok: true, detected: d, instance: inst.snapshot() });
  } catch (e) {
    inst.log('ERROR', `[MCSP] 导入失败: ${e.message}`);
    res.status(400).json({ ok: false, error: e.message });
  } finally {
    archiveBusy.delete(inst.id);
  }
}));

/* 实例配置调整:内存上限 / 外置登录(运行中修改重启后生效;普通用户受内存配额约束) */
router.patch('/:iid', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const body = req.body || {};

  if (body.xmx !== undefined) {
    const mb = parseInt(body.xmx, 10);
    if (!Number.isFinite(mb)) return res.status(400).json({ ok: false, error: 'xmx 无效' });
    if (mb < 512 || mb > 65536) return res.status(400).json({ ok: false, error: '内存上限需在 512 ~ 65536 MB 之间' });
    /* 只在**往上加**的时候查配额,持平和缩小一律放行。
       前端保存实例设置时总会带上 xmx(哪怕用户只改了个名字),所以一旦管理员调低了
       某人的配额、或者配额口径变严,已经超额的用户会连改实例名都 403 —— 而
       "把内存调小自救"这条唯一的出路,恰好也被同一条拦住。
       缩小是让账变好看的方向,没有理由挡它。 */
    if (mb > inst.xmx) {
      const qerr = quotaError(req, mb, false, inst);
      if (qerr) return res.status(403).json({ ok: false, error: qerr });
    }
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
  /* 克隆限主人/管理员。克隆出来的新实例 owner 是**调用者**,也就是说协作者
     一旦能克隆,就等于能把别人的实例连同世界和 server.properties(里面有
     rcon.password、velocity 的 forwarding.secret)整份复制成自己完全掌控的
     实例 —— 绕过了"协作者不能把实例拿走"这条直觉边界。配额算在克隆者头上
     所以不是配额问题,是数据外流。 */
  if (!isOwnerOrAdmin(req, src)) return res.status(403).json({ ok: false, error: '只有实例主人可以克隆实例' });
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

/* 协作者:主人或管理员可增删。协作者能操作实例,但不能删实例、也不能改这份名单 */
router.put('/:iid/collaborators', asyncHandler(async (req, res) => {
  const inst = req.inst;
  if (!isOwnerOrAdmin(req, inst)) return res.status(403).json({ ok: false, error: '只有实例主人可以管理协作者' });
  const list = Array.isArray(req.body && req.body.users) ? req.body.users : null;
  if (!list) return res.status(400).json({ ok: false, error: '缺少 users 数组' });
  if (list.length > 20) return res.status(400).json({ ok: false, error: '协作者最多 20 人' });

  /* users 里可以是 'alice'(沿用旧写法,按 manager 处理)
     或 {name:'alice', role:'viewer'}。两种混着传也认。 */
  const seen = new Set();
  const entries = [];
  for (const raw of list) {
    const name = String((raw && raw.name) || raw || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const role = COLLAB_ROLES.includes(raw && raw.role) ? raw.role : 'manager';
    if (!authUsers.some((u) => u.username === name)) return res.status(400).json({ ok: false, error: `用户不存在: ${name}` });
    if (name === inst.owner) return res.status(400).json({ ok: false, error: '主人本来就有权限,不用加成协作者' });
    entries.push({ name, role });
  }
  inst.collaborators = entries;
  saveRegistry();
  inst.log('INFO', `[MCSP] 协作者已更新: ${entries.length ? entries.map((e) => `${e.name}(${e.role})`).join(', ') : '(已清空)'}`);
  inst.emitState();
  bus.broadcast('instances', {});
  res.json({ ok: true, collaborators: entries });
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
  if (!isOwnerOrAdmin(req, inst)) return res.status(403).json({ ok: false, error: '只有实例主人可以删除实例' });
  /* importing 也放行:那是 POST /import 建的空壳,没有进程也没有数据,
     而它唯一的出路 finalize 需要一个有效压缩包 —— 中途放弃的导入于是卡在这里,
     删不掉也用不了(得重启面板才会因为 state 不落盘而变回 stopped)。
     没有理由让用户为了删一个空壳去重启整个面板。 */
  if (inst.state !== 'stopped' && inst.state !== 'importing') {
    return res.status(400).json({ ok: false, error: '请先停止实例再删除' });
  }
  // 压缩/备份/解压正在读写实例目录时删掉它,tar 会写出残缺产物
  if (archiveBusy.has(inst.id)) {
    return res.status(409).json({ ok: false, error: '该实例有压缩/备份任务正在进行,请等它结束再删' });
  }
  inst.cancelAutoRestart();     // 否则实例都删了,几秒后那两个定时器还会来拉一次
  if (inst.tunnelProc) inst.stopTunnel();
  if (inst.rconTunnelProc) inst.stopRconTunnel();
  fs.rmSync(path.join(DATA_DIR, `frpc-${inst.id}.toml`), { force: true });
  fs.rmSync(path.join(DATA_DIR, `frpc-rcon-${inst.id}.toml`), { force: true });
  fs.rmSync(path.join(DATA_DIR, `playit-${inst.id}.toml`), { force: true });
  fs.rmSync(path.join(DATA_DIR, 'crashes', `${inst.id}.json`), { force: true });
  playtime.remove(inst.id);     // 不留孤儿统计文件
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

// perm 同上:按请求者算,不进 snapshot()
router.get('/:iid/status', (req, res) => res.json({ ...req.inst.snapshot(), perm: req.perm }));
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

/**
 * 执行控制台命令。
 * server.properties 里开了 enable-rcon 且配了密码时优先走 RCON —— 能拿到这条命令
 * 的**输出**(stdin 只能把命令喂进去,回显混在日志流里没法对应),服务端卡住时
 * 也还有一条独立通道。RCON 不通就回落到 stdin,并说明原因。
 */
router.post('/:iid/command', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const { command } = req.body || {};
  if (typeof command !== 'string') return res.status(400).json({ ok: false, error: '缺少 command 字段' });

  const props = inst.readProps();
  const useRcon = String(props['enable-rcon']).toLowerCase() === 'true'
    && props['rcon.password'] && inst.state === 'running';

  if (useRcon) {
    try {
      const output = await rcon.exec({
        port: parseInt(props['rcon.port'], 10) || 25575,
        password: props['rcon.password'],
        command,
      });
      inst.log('INFO', `[RCON] > ${command}`);
      // 输出逐行打进控制台,和 stdout 混在一起看着才连贯
      for (const line of String(output).split('\n')) if (line.trim()) inst.log('INFO', `[RCON] ${line.trim()}`);
      return res.json({ ok: true, via: 'rcon', output });
    } catch (err) {
      inst.log('WARN', `[MCSP] RCON 执行失败,回落到 stdin: ${err.message}`);
      return res.json({ ...inst.command(command), via: 'stdin', rconError: err.message });
    }
  }
  res.json({ ...inst.command(command), via: 'stdin' });
}));

/** 一键开启 RCON:写 server.properties 并生成随机密码,重启生效 */
router.post('/:iid/rcon/enable', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const props = inst.readProps();
  const port = parseInt(props['rcon.port'], 10) || (parseInt(props['server-port'], 10) || 25565) + 10;
  props['enable-rcon'] = 'true';
  props['rcon.port'] = String(port);
  if (!props['rcon.password']) props['rcon.password'] = crypto.randomBytes(12).toString('base64url');
  inst.writeProps(props);
  inst.invalidatePropsCache();
  inst.log('INFO', `[MCSP] 已开启 RCON (端口 ${port})` + (inst.state === 'running' ? ',重启实例后生效' : ''));
  res.json({ ok: true, port, needRestart: inst.state === 'running' });
}));

router.get('/:iid/rcon', (req, res) => {
  const props = req.inst.readProps();
  res.json({
    ok: true,
    enabled: String(props['enable-rcon']).toLowerCase() === 'true',
    port: parseInt(props['rcon.port'], 10) || null,
    hasPassword: !!props['rcon.password'],
    // 明文回传密码:能调这个接口的人(主人 / 协作者)本来就能在文件管理器里
    // 直接打开 server.properties 看到它,藏在这里只会让面板里的 RCON 卡片
    // 没法接外部客户端。审计中间件会把 password 字段脱敏,不会进日志。
    password: props['rcon.password'] || null,
  });
});

/* ── 玩家:实时解析 + 服务端自己的 JSON 文件 ── */

router.get('/:iid/players', (req, res) => {
  const inst = req.inst;
  // usercache.json 是服务端自己维护的 名字↔UUID 映射,拿它给在线玩家补 UUID,
  // 前端就能显示真实皮肤头像而不是首字母色块
  const uuidOf = new Map(inst.readServerJson('usercache.json').map((u) => [String(u.name).toLowerCase(), u.uuid]));
  res.json({
    online: inst.playerList().map((p) => ({ ...p, uuid: uuidOf.get(p.name.toLowerCase()) || null })),
    // 封禁保留 reason / created / source —— 半年后回头看"这人为什么被封"全靠它
    banned: inst.readServerJson('banned-players.json').map((b) => ({
      name: b.name, reason: b.reason || '', created: b.created || '', source: b.source || '', expires: b.expires || 'forever',
    })),
    whitelist: inst.readServerJson('whitelist.json').map((w) => w.name),
    ops: inst.readServerJson('ops.json').map((o) => o.name),
  });
});

router.post('/:iid/players/:name/:action', (req, res) => {
  const { name, action } = req.params;
  if (!/^[\w.-]{1,16}$/.test(name)) return res.status(400).json({ ok: false, error: '玩家名非法' });
  // 理由是自由文本,但要过 stdin 到服务端控制台 —— 去掉换行免得被当成第二条命令
  const reason = String((req.body && req.body.reason) || '').replace(/[\r\n]/g, ' ').trim().slice(0, 120);
  const map = {
    kick: `kick ${name}${reason ? ' ' + reason : ''}`,
    ban: `ban ${name}${reason ? ' ' + reason : ''}`,
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

/** 一个目录是不是世界:认 level.dat。维度目录(DIM-1/DIM1)没有自己的 level.dat,
    所以 Paper 的 world_nether/world_the_end 会被单独识别,而原版的 world/DIM-1 不会 —— 正合适 */
const isWorldDir = (p) => fs.existsSync(path.join(p, 'level.dat'));

function worldEnv(name, level) {
  if (name === level + '_nether') return 'nether';
  if (name === level + '_the_end') return 'the_end';
  return 'normal';
}

router.get('/:iid/worlds', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const level = inst.getProp('level-name') || 'world';
  let entries = [];
  try { entries = await fsp.readdir(inst.dir, { withFileTypes: true }); } catch {}
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(inst.dir, e.name);
    if (!isWorldDir(dir)) continue;
    const env = worldEnv(e.name, level);
    out.push({
      name: e.name,
      env,
      // 主世界 = 当前 level-name;它的下界/末地也算"在用",不给单独删
      active: e.name === level,
      linked: env !== 'normal' && e.name.startsWith(level),
      sizeMB: +((await dirSize(dir)) / 1048576).toFixed(1),
      mtime: (await fsp.stat(dir)).mtimeMs,
    });
  }
  out.sort((a, b) => (b.active - a.active) || a.name.localeCompare(b.name));
  res.json(out);
}));

/** 切换当前世界:改 level-name,重启生效 */
router.post('/:iid/worlds/activate', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const name = String((req.body && req.body.name) || '');
  if (!isSafeName(name)) return res.status(400).json({ ok: false, error: '世界名非法' });
  if (!isWorldDir(path.join(inst.dir, name))) return res.status(404).json({ ok: false, error: '该目录不是一个世界(缺少 level.dat)' });
  const props = inst.readProps();
  props['level-name'] = name;
  inst.writeProps(props);
  inst.invalidatePropsCache();
  inst.log('INFO', `[MCSP] 当前世界已切换为 ${name}` + (inst.state === 'running' ? '(重启后生效)' : ''));
  inst.emitState();
  res.json({ ok: true });
}));

/** 新建世界:只写 level-name(+可选种子),真正的地形由服务端下次启动时生成 */
router.post('/:iid/worlds/create', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const { name, seed } = req.body || {};
  const n = String(name || '').trim();
  if (!isSafeName(n)) return res.status(400).json({ ok: false, error: '世界名非法' });
  if (fs.existsSync(path.join(inst.dir, n))) return res.status(409).json({ ok: false, error: '同名目录已存在' });
  if (inst.state !== 'stopped') return res.status(400).json({ ok: false, error: '请先停止实例再新建世界' });

  const props = inst.readProps();
  props['level-name'] = n;
  props['level-seed'] = String(seed || '').replace(/[\r\n=]/g, '').slice(0, 64);
  inst.writeProps(props);
  inst.invalidatePropsCache();
  inst.log('INFO', `[MCSP] 已切换到新世界 ${n}${props['level-seed'] ? ` (种子 ${props['level-seed']})` : ''},启动实例后由服务端生成地形`);
  inst.emitState();
  res.json({ ok: true, note: '启动实例后服务端会生成这个世界' });
}));

router.delete('/:iid/worlds/:name', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const name = req.params.name;
  if (!isSafeName(name)) return res.status(400).json({ ok: false, error: '世界名非法' });
  const level = inst.getProp('level-name') || 'world';
  // 正在用的世界(以及它的下界/末地)不给删 —— 删完服务端会重新生成一个空世界,
  // 用户多半以为是"清档"其实是丢档
  if (name === level || name.startsWith(level + '_')) {
    return res.status(400).json({ ok: false, error: `「${name}」是当前正在使用的世界,请先切换到别的世界再删` });
  }
  if (inst.state !== 'stopped') return res.status(400).json({ ok: false, error: '请先停止实例再删除世界' });
  const dir = path.join(inst.dir, name);
  if (!isWorldDir(dir)) return res.status(404).json({ ok: false, error: '世界不存在' });
  await fsp.rm(dir, { recursive: true, force: true });
  disk.refresh(inst.id);
  inst.log('WARN', `[MCSP] 已删除世界 ${name}`);
  res.json({ ok: true });
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

  /* 原先这里写死 diskQuotaError(req, 64) —— 注释说"jar 一般几 MB,给个宽松的预检额度",
     但整合包和大型模组远不止 64 MB,而 install 的下载是无界流式写入:只要剩余配额
     ≥64 MB 就放行,之后写多少算多少。改成把真实体积交给 modrinth 去卡
     (它的版本信息里本来就带 file.size),并在下载过程中按已写字节持续复查。 */
  const checkQuota = (bytes) => diskQuotaError(req, bytes / 1048576);
  const dqerr = checkQuota(0);                // 配额已经满了就不必发起请求
  if (dqerr) return res.status(403).json({ ok: false, error: dqerr });

  try {
    const r = await modrinth.install({
      projectId, versionId, type: inst.type, version: inst.version,
      destDir: path.join(inst.dir, ext.name),
      checkQuota,
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
  /* 和解压/打包共用一把锁。增量备份靠一个 .snar 快照文件记"上次备份到哪",
     tar --listed-incremental 会就地改写它 —— 两个增量备份并发跑,就是两个
     进程同时读写同一份快照,整条增量链会被写坏,而且要等到恢复时才发现 */
  if (archiveBusy.has(req.inst.id)) {
    return res.status(409).json({ ok: false, error: '该实例已有压缩任务在进行中' });
  }
  archiveBusy.add(req.inst.id);
  let r;
  try {
    r = await createBackup(req.inst, req.body && req.body.name, { mode: req.body && req.body.mode });
  } finally {
    archiveBusy.delete(req.inst.id);
  }
  disk.refresh(req.inst.id);      // 保留策略可能顺手删了旧包,增量算不准,直接重算
  res.json(r.ok ? { ...r, backups: listBackups(req.inst) } : r);
}));

/* 恢复前预览:列归档内容、验完整性、指出哪些现有目录会被盖掉。只读 */
router.get('/:iid/backups/:id/inspect', asyncHandler(async (req, res) => {
  if (!isBackupId(req.params.id)) return res.status(404).json({ ok: false, error: '备份不存在' });
  res.json(await inspectBackup(req.inst, req.params.id));
}));

router.post('/:iid/backups/:id/restore', asyncHandler(async (req, res) => {
  if (!isBackupId(req.params.id)) return res.status(404).json({ ok: false, error: '备份不存在' });
  if (req.inst.state !== 'stopped') return res.json({ ok: false, error: '请先停止实例再恢复备份' });

  /* 恢复是第六条能往实例目录里写入大量数据的路径,原先它是唯一一条**不校验配额**的。
     否则:备份 → 删掉实例里的文件(占用回落)→ 恢复 → 再来一轮,就能把占用推到配额之上。
     算的是**净增长**(归档解开后的体积 - 当前实例占用):恢复是覆盖式的,
     恢复一个和现在差不多大的包净增长约等于 0,不该被拦。
     增量链按各归档之和取上界(增量里改过的文件会重复计),宁可偏保守。 */
  const pre = await inspectBackup(req.inst, req.params.id);
  if (!pre.ok) return res.json(pre);                    // 包损坏/链缺环,原样把原因回给用户
  let needBytes = pre.totalBytes || 0;
  for (const other of (pre.chain || []).filter((c) => c !== req.params.id)) {
    const s = await inspectBackup(req.inst, other);
    if (s.ok) needBytes += s.totalBytes || 0;
  }
  const growthMB = Math.max(0, needBytes / 1048576 - disk.instanceUsage(req.inst.id).instMB);
  const dqerr = diskQuotaError(req, growthMB);
  if (dqerr) return res.status(403).json({ ok: false, error: dqerr });

  // 恢复要往实例目录里解包,和备份/解压/打包必须互斥,否则解一半被另一个覆盖
  if (archiveBusy.has(req.inst.id)) {
    return res.status(409).json({ ok: false, error: '该实例已有压缩任务在进行中' });
  }
  archiveBusy.add(req.inst.id);
  try {
    res.json(await restoreBackup(req.inst, req.params.id));
  } finally {
    archiveBusy.delete(req.inst.id);
  }
}));

/* ── 玩家在线时长(功能 14)── */

router.get('/:iid/playtime', (req, res) => {
  res.json({ ok: true, players: playtime.list(req.inst.id, req.inst.players) });
});

router.delete('/:iid/playtime', (req, res) => {
  playtime.reset(req.inst.id);
  res.json({ ok: true });
});

/* ── 崩溃现场(功能 3)── */

router.get('/:iid/crashes', (req, res) => {
  // 不回 tail,列表页只要摘要;整包 tail 有几百 KB
  res.json({
    ok: true,
    crashes: (req.inst.crashes || []).map((c, i) => ({
      index: i, at: c.at, exitCode: c.exitCode, signal: c.signal,
      report: c.report, tailLines: (c.tail || []).length,
    })),
  });
});

/** 单次崩溃的完整现场:面板日志 tail + 服务端 crash-report 正文 */
router.get('/:iid/crashes/:index', (req, res) => {
  const c = (req.inst.crashes || [])[parseInt(req.params.index, 10)];
  if (!c) return res.status(404).json({ ok: false, error: '崩溃记录不存在' });
  let report = null;
  if (c.report) {
    try {
      // 只认 basename:report 是自己写进去的,但它来自读目录,
      // 万一有人在 crash-reports/ 里放了个带 ../ 的文件名也不能让它跑出去
      const f = path.join(req.inst.dir, 'crash-reports', path.basename(c.report));
      report = fs.readFileSync(f, 'utf8').slice(0, 512 * 1024);
    } catch (err) {
      report = `[无法读取 ${c.report}: ${err.message}]`;
    }
  }
  res.json({ ok: true, crash: { ...c, reportText: report } });
});

router.delete('/:iid/crashes', (req, res) => {
  req.inst.crashes = [];
  req.inst._saveCrashes();
  res.json({ ok: true });
});

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
  /* stat 并发发出去,别一个个 await:5000 个文件的目录串行要 250ms,
     而这些 stat 之间毫无依赖。分批是为了不把 libuv 线程池一次灌爆,
     那样反而会拖慢同时在跑的上传和备份 */
  const STAT_BATCH = 64;
  const out = [];
  for (let i = 0; i < entries.length; i += STAT_BATCH) {
    const slice = entries.slice(i, i + STAT_BATCH);
    const stats = await Promise.all(slice.map((e) => fsp.stat(path.join(p, e.name)).catch(() => null)));
    for (let k = 0; k < slice.length; k++) {
      const e = slice[k];
      const st = stats[k];
      if (!st) continue;                       // 列目录到 stat 之间被删掉了,跳过
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
    // 同样先收余量:这条路上一个字节都还没读,连接里全是没人管的 body
    if (!(await drainRequest(req))) res.on('finish', () => req.destroy());
    res.set('Connection', 'close');
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
      const qerr = diskQuotaError(req, max / 1048576 + 1);
      // 先收完余量再回话,别让反代把 RST 翻译成 502(见 drainRequest)
      if (!(await drainRequest(req))) res.on('finish', () => req.destroy());
      res.set('Connection', 'close');
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

/* ── 分片上传 ──
 *
 * 上面那条一次传完的路子,遇到把面板架在隧道 / Cloudflare Worker 后面的部署会挂:
 * 这类链路在请求体 10 MB 出头就直接 502,请求根本到不了面板。于是给大文件加一条
 * init → chunk ×N → finish 的路。小文件仍走上面那条(少两次往返)。
 *
 * 落盘见 src/uploads.js 的说明:一个临时文件,每片写自己的偏移。
 *
 * 权限:这几条都挂在 /:iid 下且非 GET,权限门(见文件上方 requiredLevel)会自动
 * 判成 manager —— 和一次传完那条一致,不用也不该动 OPERATOR_WRITES。
 */

/** 提前拒绝时统一走这里:先把连接里剩下的 body 收掉,别让反代把 RST 翻成 502 */
async function rejectChunk(req, res, status, error) {
  if (!(await drainRequest(req))) res.on('finish', () => req.destroy());
  res.set('Connection', 'close');
  return res.status(status).json({ ok: false, error });
}

router.post('/:iid/files/upload/init', asyncHandler(async (req, res) => {
  const { path: dir, name: rawName, size: rawSize, overwrite } = req.body || {};
  const name = String(rawName || '');
  if (!isSafeName(name)) return res.status(400).json({ ok: false, error: '文件名非法' });

  const parent = safePath(req.inst, dir);
  if (!parent) return res.status(400).json({ ok: false, error: '非法路径' });
  let pst;
  try { pst = await fsp.stat(parent); } catch { return res.status(404).json({ ok: false, error: '目录不存在' }); }
  if (!pst.isDirectory()) return res.status(400).json({ ok: false, error: '目标不是目录' });

  const size = Number(rawSize);
  if (!Number.isSafeInteger(size) || size <= 0) {
    return res.status(400).json({ ok: false, error: '文件大小非法' });
  }

  const dest = path.join(parent, name);
  if (fs.existsSync(dest)) {
    if (!overwrite) return res.status(409).json({ ok: false, error: '同名文件已存在' });
    if (fs.statSync(dest).isDirectory()) return res.status(409).json({ ok: false, error: '同名目录已存在' });
  }

  if (size > MAX_UPLOAD_MB * 1048576) {
    return res.status(413).json({ ok: false, error: `文件超过上传大小上限 ${MAX_UPLOAD_MB} MB` });
  }
  const qerr = diskQuotaError(req, size / 1048576);
  if (qerr) return res.status(403).json({ ok: false, error: qerr });

  let s;
  try {
    s = await uploads.create({
      iid: req.inst.id,
      username: req.user.username,
      parentRel: String(dir || '/'),
      name,
      tmpDir: parent,
      size,
      chunkSize: UPLOAD_CHUNK_MB * 1048576,
      overwrite,
    });
  } catch (err) {
    if (err.tooMany) return res.status(429).json({ ok: false, error: err.message });
    throw err;
  }

  /* 配额按声明体积**全额预扣**,abort / GC 时退回。
     只按片记或只在 finish 记的话,用户能同时开十个大上传 —— 每个 init 都因为
     "还没人记账"而通过检查,合起来直接击穿配额。这正是 disk.bump 当初要堵的洞,
     被并发重新打开了。宁可在途期间高报。 */
  disk.bump(req.inst.id, size / 1048576);

  res.json({
    ok: true,
    uploadId: s.uploadId,
    chunkSize: s.chunkSize,   // 以服务端为准,前端不许拿自己的配置切片
    chunks: s.chunks,
    received: [],             // v1 恒为空;先占好位,将来加续传协议不用变
  });
}));

router.post('/:iid/files/upload/chunk', asyncHandler(async (req, res) => {
  const uploadId = String(req.query.uploadId || '');
  if (!uploads.isUploadId(uploadId)) return rejectChunk(req, res, 400, 'uploadId 非法');

  const s = uploads.get(uploadId, { iid: req.inst.id, username: req.user.username });
  if (!s) return rejectChunk(req, res, 404, '上传会话不存在或已过期');
  if (s.finishing) return rejectChunk(req, res, 409, '该上传正在合并,不能再收分片');

  const index = Number(req.query.index);
  if (!Number.isInteger(index) || index < 0 || index >= s.chunks) {
    return rejectChunk(req, res, 400, '分片序号越界');
  }
  if (s.writing.has(index)) return rejectChunk(req, res, 409, '该分片正在写入');

  /* 每片的**精确**期望长度(末片是余数)。只判上限是不够的:短于期望意味着文件
     中间留了个零洞,却会一路 ok 到 rename —— 那是唯一会静默产出损坏文件的路径。 */
  const start = index * s.chunkSize;
  const expect = Math.min(s.chunkSize, s.size - start);

  s.writing.add(index);
  s.touchedAt = Date.now();
  let written;
  try {
    written = await receiveUpload(req, s.tmp, expect, { flags: 'r+', start });
  } catch (err) {
    s.writing.delete(index);
    if (err.tooLarge) return rejectChunk(req, res, 413, `分片超过约定大小(应为 ${expect} 字节)`);
    // 临时文件被人从文件管理器里删了,或者磁盘满了 —— 都不是 500
    if (err.code === 'ENOENT') return rejectChunk(req, res, 404, '上传会话的临时文件已丢失,请重新上传');
    if (err.code === 'ENOSPC') return rejectChunk(req, res, 507, '磁盘空间不足,上传中断');
    if (res.headersSent || req.destroyed) return;    // 客户端自己断的
    return res.status(400).json({ ok: false, error: `分片写入失败: ${err.message}` });
  }
  s.writing.delete(index);

  if (written !== expect) {
    return rejectChunk(req, res, 400, `分片长度不符(应为 ${expect} 字节,实收 ${written})`);
  }

  if (!s.received[index]) { s.received[index] = 1; s.receivedCount++; }
  s.touchedAt = Date.now();
  res.json({ ok: true, index, received: s.receivedCount, total: s.chunks });
}));

router.post('/:iid/files/upload/finish', asyncHandler(async (req, res) => {
  const uploadId = String((req.body || {}).uploadId || '');
  if (!uploads.isUploadId(uploadId)) return res.status(400).json({ ok: false, error: 'uploadId 非法' });

  const s = uploads.get(uploadId, { iid: req.inst.id, username: req.user.username });
  if (!s) return res.status(404).json({ ok: false, error: '上传会话不存在或已过期' });
  if (s.finishing) return res.status(409).json({ ok: false, error: '该上传已在合并中' });
  /* 还有分片在写就不能收尾:rename 之后那个写流仍然连着同一个 inode,
     用户会看到一个已经"完成"的文件还在自己变大 */
  if (s.writing.size) return res.status(409).json({ ok: false, error: '仍有分片正在写入,请稍后' });
  if (s.receivedCount !== s.chunks) {
    return res.status(409).json({ ok: false, error: `分片不完整(${s.receivedCount}/${s.chunks}),不能合并` });
  }
  s.finishing = true;   // 必须在第一个 await 之前置位

  /* init 到 finish 可能隔了几十分钟,期间父目录可能被删、改名,或者被换成一个
     指向沙箱外的软链 —— safePath 的 realpath 校验正是为此存在,只在 init 查一次
     等于没查。所以这里整套重来一遍。 */
  const parent = safePath(req.inst, s.parentRel);
  if (!parent) { await uploads.discard(uploadId); return res.status(400).json({ ok: false, error: '非法路径' }); }
  let pst;
  try { pst = await fsp.stat(parent); } catch {
    await uploads.discard(uploadId);
    return res.status(404).json({ ok: false, error: '目标目录已不存在,上传作废' });
  }
  if (!pst.isDirectory()) {
    await uploads.discard(uploadId);
    return res.status(400).json({ ok: false, error: '目标不是目录' });
  }
  // 父目录被改名的话 s.tmp 指向的已经是别处,再 rename 进来就越过了刚做的校验
  if (path.dirname(s.tmp) !== parent) {
    await uploads.discard(uploadId);
    return res.status(409).json({ ok: false, error: '目标目录在上传期间发生变动,上传作废' });
  }

  const dest = path.join(parent, s.name);
  if (fs.existsSync(dest)) {
    if (!s.overwrite) {
      await uploads.discard(uploadId);
      return res.status(409).json({ ok: false, error: '同名文件在上传期间被创建,已取消(请重新上传并选择覆盖)' });
    }
    if (fs.statSync(dest).isDirectory()) {
      await uploads.discard(uploadId);
      return res.status(409).json({ ok: false, error: '同名目录已存在' });
    }
  }

  /* 收尾前按声明体积截一刀:某一片被重传成更短的内容时,旧的长尾巴还留在文件里,
     不截的话 rename 出去的就是个尾部带垃圾的文件 */
  await fsp.truncate(s.tmp, s.size);
  await fsp.rename(s.tmp, dest);
  uploads.forget(uploadId);

  /* 配额在 init 时已按 size 全额预扣,这里不重复记。覆盖写的话被顶掉的那份体积
     成了多算的,交给 refresh 自愈(DELETE /files 也是这么处理的) */
  if (s.overwrite) disk.refresh(req.inst.id);

  const rel = path.posix.join(s.parentRel, s.name);
  req.inst.log('INFO', `[MCSP] 已上传: ${rel} (${(s.size / 1048576).toFixed(2)} MB,${s.chunks} 个分片)`);
  if (s.name === 'server.properties') req.inst.invalidatePropsCache();
  res.json({ ok: true, name: s.name, size: s.size });
}));

router.post('/:iid/files/upload/abort', asyncHandler(async (req, res) => {
  const uploadId = String((req.body || {}).uploadId || '');
  /* 幂等:客户端是在说"这个我不要了",对一个本来就不存在的东西说这句话,
     唯一正确的回应是"好" —— 让它 404 只会给断线重试添乱 */
  if (uploads.isUploadId(uploadId)) {
    const s = uploads.get(uploadId, { iid: req.inst.id, username: req.user.username });
    if (s) await uploads.discard(uploadId);
  }
  res.json({ ok: true });
}));

router.delete('/:iid/files', asyncHandler(async (req, res) => {
  const p = safePath(req.inst, req.query.path);
  if (!p || p === req.inst.dir) return res.status(400).json({ ok: false, error: '非法路径' });
  await fsp.rm(p, { recursive: true, force: true });
  disk.refresh(req.inst.id);      // 删的可能是个大目录,不重算用户会被旧数字白白挡着
  req.inst.log('INFO', `[MCSP] 已删除: ${req.query.path}`);
  res.json({ ok: true });
}));

/* ── 批量操作与剪贴板(移动 / 复制)── */

/* 一次最多处理多少项:挡住手滑或脚本把几万条名字塞进来 */
const BATCH_MAX = 500;

/* 移动/复制的互斥锁。不复用 archiveBusy:打包动辄几分钟,粘贴通常亚秒级,
   共用一把锁会让后台打包期间每次粘贴都 409,而且弹的是"已有压缩任务"这种
   驴唇不对马嘴的提示。两者也不像两个并发打包那样真的互斥(不写同一个输出)。 */
const fileOpBusy = new Set();

/**
 * 目标目录是不是源自身、或源的子孙。
 * 把 /world 移进 /world/sub 会无限递归;系统调用层面其实会拒(rename → EINVAL、
 * cp → ERR_FS_CP_EINVAL),但那是在批量跑到这一项时才炸,前面几项已经动过了。
 * 所以前置成纯词法判断,整批一起拒。
 *
 * 注意不能只 startsWith(src):'/a/worldsave'.startsWith('/a/world') 是 true,
 * 会把无辜的同前缀目录一起误伤。必须补上分隔符。
 */
const isSelfOrDescendant = (src, destDir) =>
  destDir === src || destDir.startsWith(src + path.sep);

/**
 * 目标目录里已有同名时挑一个不冲突的名字:config.yml → config (2).yml。
 * 已经带 (n) 后缀的接着往下数,免得叠成 "config (2) (2).yml"。
 *
 * 用 O_EXCL 占位而不是"先 existsSync 再写":后者在两个标签页同时粘贴时
 * 会挑到同一个名字,而 fsp.rename 覆盖已存在文件是**静默成功**的(实测),
 * 于是先落地的那份被无声吃掉。这里原子地把名字占下来,调用方随后替换。
 */
async function reserveUniqueName(dir, name) {
  const dotfile = name.startsWith('.') && name.indexOf('.', 1) === -1;
  const ext = dotfile ? '' : path.extname(name);
  let stem = ext ? name.slice(0, -ext.length) : name;
  let n = 1;
  const m = stem.match(/^(.*) \((\d+)\)$/);
  if (m) { stem = m[1]; n = parseInt(m[2], 10); }

  let candidate = name;
  for (let i = 0; i < 10000; i++) {
    try {
      const fh = await fsp.open(path.join(dir, candidate), 'wx');
      await fh.close();
      return candidate;                       // 占位文件已建,调用方负责删掉再写
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      candidate = `${stem} (${++n})${ext}`;
    }
  }
  throw new Error('重名太多,无法生成新名字');
}

/** 批量删除 { dir, names[] } */
router.delete('/:iid/files/batch', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const { dir, names } = req.body || {};
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ ok: false, error: '没有选中任何项' });
  if (names.length > BATCH_MAX) return res.status(400).json({ ok: false, error: `一次最多 ${BATCH_MAX} 项` });
  if (!names.every(isSafeName)) return res.status(400).json({ ok: false, error: '名称非法' });

  const parent = safePath(inst, dir);
  if (!parent) return res.status(400).json({ ok: false, error: '非法路径' });
  if (!fs.existsSync(parent) || !(await fsp.stat(parent)).isDirectory()) {
    return res.status(404).json({ ok: false, error: '目录不存在' });
  }

  const done = [], failed = [];
  for (const name of names) {
    const p = path.join(parent, name);
    if (p === inst.dir) { failed.push({ name, error: '非法路径' }); continue; }
    try { await fsp.rm(p, { recursive: true, force: true }); done.push(name); }
    catch (e) { failed.push({ name, error: e.code || e.message }); }
  }

  disk.refresh(inst.id);          // 删的可能是几个大目录,增量算不出来,整体重扫
  if (names.includes('server.properties')) inst.invalidatePropsCache();
  inst.log('INFO', `[MCSP] 批量删除 ${done.length} 项${failed.length ? `,失败 ${failed.length} 项` : ''}`);
  res.json({ ok: !failed.length, done, failed });
}));

/** 移动 / 复制 { op:'move'|'copy', from, names[], to } —— 剪贴板的落地接口 */
router.post('/:iid/files/transfer', asyncHandler(async (req, res) => {
  const inst = req.inst;
  const { op, from, names, to } = req.body || {};
  if (op !== 'move' && op !== 'copy') return res.status(400).json({ ok: false, error: '操作无效' });
  if (!Array.isArray(names) || !names.length) return res.status(400).json({ ok: false, error: '没有选中任何项' });
  if (names.length > BATCH_MAX) return res.status(400).json({ ok: false, error: `一次最多 ${BATCH_MAX} 项` });
  if (!names.every(isSafeName)) return res.status(400).json({ ok: false, error: '名称非法' });

  const srcDir = safePath(inst, from);
  const dstDir = safePath(inst, to);
  if (!srcDir || !dstDir) return res.status(400).json({ ok: false, error: '非法路径' });

  /* 词法守卫排在文件系统探测之前 —— 越界请求的返回码就不会取决于
     实例里恰好有没有那个目录 */
  for (const name of names) {
    if (isSelfOrDescendant(path.join(srcDir, name), dstDir)) {
      return res.status(400).json({ ok: false, error: `不能把「${name}」放进它自己里面` });
    }
  }
  if (op === 'move' && srcDir === dstDir) return res.json({ ok: true, done: [], failed: [] });

  if (!fs.existsSync(dstDir) || !(await fsp.stat(dstDir)).isDirectory()) {
    return res.status(404).json({ ok: false, error: '目标目录不存在' });
  }

  const items = [], failed = [];
  for (const name of names) {
    const src = path.join(srcDir, name);
    let st;
    try {
      st = await fsp.lstat(src);
    } catch {
      // 剪贴板放着的时候别的标签页把文件删了 —— 这是常态,不该整批崩掉,
      // 逐项报告即可(格式非法之类的才值得整批拒)
      failed.push({ name, error: '已不存在' });
      continue;
    }
    // 软链一律拒绝:复制它会在目标位置重建一个指向沙箱外的链接,
    // 相当于把越权推迟到下一次请求。archive.js 打包时也是这么跳过的。
    if (st.isSymbolicLink()) return res.status(400).json({ ok: false, error: `不支持移动/复制软链接:${name}` });
    if (!st.isFile() && !st.isDirectory()) return res.status(400).json({ ok: false, error: `不支持的文件类型:${name}` });
    items.push({ name, src, isDir: st.isDirectory(), size: st.size });
  }
  if (!items.length) return res.status(404).json({ ok: false, error: '选中的项都已不存在' });

  /* 复制才吃配额。移动在同一文件系统里是零字节增减,拦它反而会把
     已经超配额的用户锁死在无法整理的状态 */
  let needMB = 0;
  if (op === 'copy') {
    for (const it of items) needMB += (it.isDir ? await dirSize(it.src) : it.size) / 1048576;
    const qerr = diskQuotaError(req, needMB);
    if (qerr) return res.status(403).json({ ok: false, error: qerr });
  }

  if (fileOpBusy.has(inst.id)) return res.status(409).json({ ok: false, error: '该实例已有文件操作在进行中' });
  fileOpBusy.add(inst.id);
  const done = [];
  try {
    for (const it of items) {
      let placeholder = null;
      try {
        const finalName = await reserveUniqueName(dstDir, it.name);
        placeholder = path.join(dstDir, finalName);
        await fsp.rm(placeholder, { force: true });          // 占位是个空文件,先撤掉
        if (op === 'move') {
          try { await fsp.rename(it.src, placeholder); }
          catch (e) {
            if (e.code !== 'EXDEV') throw e;                 // 跨设备时 rename 不管用,退化成拷完再删
            await fsp.cp(it.src, placeholder, { recursive: true, verbatimSymlinks: true });
            await fsp.rm(it.src, { recursive: true, force: true });
          }
        } else {
          // dereference 保持默认 false:实测传 true 会把软链指向的沙箱外内容
          // 真的拷进实例目录。verbatimSymlinks 再兜住目录内部嵌套的软链。
          await fsp.cp(it.src, placeholder, {
            recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true,
          });
        }
        done.push({ name: it.name, as: finalName });
      } catch (e) {
        if (placeholder) await fsp.rm(placeholder, { recursive: true, force: true }).catch(() => {});
        failed.push({ name: it.name, error: e.code || e.message });
      }
    }
  } finally {
    fileOpBusy.delete(inst.id);
  }

  if (op === 'copy') {
    // 中途失败时已拷字节数算不准,直接整体重扫
    if (failed.length) disk.refresh(inst.id); else disk.bump(inst.id, needMB);
  }
  if (names.includes('server.properties')) inst.invalidatePropsCache();
  inst.log('INFO', `[MCSP] ${op === 'move' ? '移动' : '复制'} ${done.length} 项到 ${to}${failed.length ? `,失败 ${failed.length} 项` : ''}`);
  res.json({ ok: !failed.length, done, failed });
}));

/* 重命名 / 同目录内改名(跨目录移动走 /files/transfer,这里只改最后一段) */
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
  /* 上界一年:Infinity 能过 ">= 1",但 Infinity * 60000 还是 Infinity,
     调度器里那句 `Date.now() - base >= minutes * 60000` 永远不成立 ——
     任务建出来了、列表里也看得见,就是永远不执行。NaN 同理(比较恒为 false),
     还会以 null 落进 tasks.json。这种"看着建成了其实是死的"最难查 */
  const mins = Math.floor(Number(schedule && schedule.minutes));
  if (schedule && schedule.type === 'interval' && Number.isFinite(mins) && mins >= 1 && mins <= 527040) {
    sched = { type: 'interval', minutes: mins };
  } else if (schedule && schedule.type === 'daily' && /^([01]\d|2[0-3]):[0-5]\d$/.test(schedule.time || '')) {
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
  res.json({
    ok: true, config: inst.tunnel,
    state: inst.tunnelState, addr: inst.tunnelAddr, error: inst.tunnelError, claim: inst.tunnelClaim,
    rcon: { state: inst.rconTunnelState, addr: inst.rconTunnelAddr, error: inst.rconTunnelError },
  });
});

router.put('/:iid/tunnel', (req, res) => {
  const inst = req.inst;
  const { type, ngrok, frpc, bore, pinggy, serveo, rcon } = req.body || {};
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
    rcon: { remotePort: Math.min(65535, Math.max(0, parseInt(rcon && rcon.remotePort, 10) || 0)) },
  };
  saveRegistry();
  inst.log('INFO', `[MCSP] 穿透配置已保存 (${type === 'none' ? '不启用' : type})${inst.tunnelProc ? ',重启隧道后生效' : ''}`);
  res.json({ ok: true, config: inst.tunnel });
});

router.post('/:iid/tunnel/start', (req, res) => res.json(req.inst.startTunnel()));
router.post('/:iid/tunnel/stop', (req, res) => res.json(req.inst.stopTunnel()));

/* RCON 端口的独立隧道。把 RCON 挂到公网影响面比游戏端口大得多,
   所以这两个操作限定实例主人/管理员 —— operator 档不够格 */
router.post('/:iid/tunnel/rcon/start', (req, res) => {
  const inst = req.inst;
  if (!isOwnerOrAdmin(req, inst)) return res.status(403).json({ ok: false, error: '只有实例主人可以开启 RCON 穿透' });
  // 远端端口随启动请求带来并顺手持久化。这样前端不必为了改一个端口
  // 去 PUT 整份穿透配置 —— 那会拿调用方的表单快照盖掉其它字段
  if (req.body && 'remotePort' in req.body) {
    inst.tunnel.rcon = { remotePort: Math.min(65535, Math.max(0, parseInt(req.body.remotePort, 10) || 0)) };
    saveRegistry();
  }
  res.json(inst.startRconTunnel());
});
router.post('/:iid/tunnel/rcon/stop', (req, res) => res.json(req.inst.stopRconTunnel()));

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
/* 供 smoke 做本地往返测试 —— 自动改名的边界(复合后缀、已有 (n)、dotfile)
   最容易在重构时悄悄改掉行为,而这条路径不需要起服务器就能验 */
module.exports.reserveUniqueName = reserveUniqueName;
