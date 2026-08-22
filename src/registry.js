/** 实例注册表:加载/持久化实例元数据,新实例的下载安装流程 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { REGISTRY_FILE } = require('./config');
const { readJson, writeJson } = require('./utils');
const { Instance, listeningPorts } = require('./instance');
const { TYPES, resolveDownload } = require('./servertypes');
const { resolveJavaBin } = require('./java');
const bus = require('./bus');
// 只用 createBackup(重装前留一份);backups 不反向依赖 registry,不成环
const { createBackup } = require('./backups');

const instances = new Map();

function saveRegistry() {
  writeJson(REGISTRY_FILE, [...instances.values()].map((i) => i.meta()));
}

function loadRegistry() {
  for (const meta of readJson(REGISTRY_FILE, [])) {
    const inst = new Instance(meta);
    if (fs.existsSync(inst.dir)) instances.set(inst.id, inst);
  }
  bus.resolveAllowed = (iid) => {
    const i = instances.get(iid);
    return i ? [i.owner, ...i.collaborators] : null;
  };
  saveRegistry();
}

function startMetricsLoop() {
  setInterval(() => { for (const inst of instances.values()) inst.tickMetrics(); }, 2000);
}

/* 恢复时错峰:几个 MC 服同时启动会把磁盘和 CPU 顶满,谁都起不来 */
const RESUME_STAGGER_MS = 5000;
const RESUME_FIRST_DELAY_MS = 2000;

/**
 * 面板重启后把之前在运行的实例拉回来。
 * 只认 autoStart && wasRunning —— 用户主动停掉的实例不会因为面板重启又自己跑起来。
 */
function resumeInstances() {
  const pending = [...instances.values()].filter((i) => i.autoStart && i.wasRunning);
  if (!pending.length) return;
  console.log(`[MCSP] 面板重启,将恢复 ${pending.length} 个之前在运行的实例(每 ${RESUME_STAGGER_MS / 1000}s 一个)`);
  pending.forEach((inst, idx) => {
    setTimeout(() => {
      if (inst.state !== 'stopped') return;      // 这期间用户可能已经自己点了启动
      inst.log('INFO', '[MCSP] 面板重启,自动恢复运行');
      const r = inst.start({ auto: true });
      if (!r.ok) inst.log('ERROR', `[MCSP] 自动恢复失败: ${r.error}`);
    }, RESUME_FIRST_DELAY_MS + idx * RESUME_STAGGER_MS);
  });
}

/** 流式下载到实例目录,进度映射到 [from,to] 区间;支持多候选 URL 回退 */
async function downloadTo(inst, info, [from, to]) {
  const urls = info.candidates || [info.url];
  let lastErr;
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(600000), redirect: 'follow' });
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
      const total = info.size || parseInt(res.headers.get('content-length'), 10) || 0;
      const file = fs.createWriteStream(path.join(inst.dir, info.name));
      const h256 = crypto.createHash('sha256');
      const h1 = crypto.createHash('sha1');
      let received = 0, lastPct = -1;

      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        file.write(value);
        h256.update(value); h1.update(value);
        received += value.length;
        if (total) {
          const pct = Math.floor((received / total) * 100);
          if (pct !== lastPct) {
            lastPct = pct;
            inst.installProgress = from + Math.floor((pct / 100) * (to - from));
            if (pct % 10 === 0) inst.log('INFO', `[MCSP] 下载进度 ${pct}%`);
            inst.emitState();
          }
        }
      }
      await new Promise((r, j) => file.end((e) => (e ? j(e) : r())));

      if (info.sha256 && h256.digest('hex') !== info.sha256) throw new Error('SHA-256 校验失败,文件可能损坏');
      if (info.sha1 && h1.digest('hex') !== info.sha1) throw new Error('SHA-1 校验失败,文件可能损坏');
      if (info.sha256 || info.sha1) inst.log('INFO', '[MCSP] 校验通过');
      return;
    } catch (err) {
      lastErr = err;
      fs.rmSync(path.join(inst.dir, info.name), { force: true });
    }
  }
  throw lastErr;
}

/** Forge / NeoForge:运行官方安装器(java -jar xxx-installer.jar --installServer) */
function runInstaller(inst, jarName) {
  const javaBin = resolveJavaBin(inst.version);
  inst.log('INFO', `[MCSP] 运行官方安装器(下载依赖库,可能需要几分钟):${path.basename(javaBin)} -jar ${jarName} --installServer`);
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(javaBin, ['-jar', jarName, '--installServer'], { cwd: inst.dir });
    } catch (err) {
      return reject(new Error(`无法运行安装器: ${err.message}(请先在总览页一键安装 Java)`));
    }
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch {}
      reject(new Error('安装器运行超时(15 分钟)'));
    }, 900000);
    let buf = '';
    const onData = (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) inst.log('INFO', `[installer] ${line.slice(0, 200)}`);
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`无法运行安装器: ${err.message}(请先在总览页一键安装 Java)`));
    });
    p.on('exit', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`安装器退出码 ${code}`));
    });
  });
}

/** 安装器结束后确定启动方式:新版走 @args 文件,旧版找 forge 主 jar */
function finalizeInstallerLayout(inst, installerName) {
  fs.rmSync(path.join(inst.dir, installerName), { force: true });
  fs.rmSync(path.join(inst.dir, installerName + '.log'), { force: true });
  if (inst.findArgsFile()) return;   // 新版:启动时用 @libraries/**/unix_args.txt
  const jar = fs.readdirSync(inst.dir).find((f) =>
    /^(forge|neoforge)-.*\.jar$/i.test(f) && !f.includes('installer'));
  if (!jar) throw new Error('安装器完成但未找到服务端启动文件');
  inst.jar = jar;                    // 旧版(≤1.16.5):universal jar 直接 -jar 启动
}

/** 下载服务端并初始化实例目录(eula / properties / plugins 或 mods) */
async function installInstance(inst, { port, gamemode, motd }) {
  const t = TYPES[inst.type] || TYPES.paper;
  inst.state = 'installing';
  inst.installProgress = 0;
  inst.emitState();
  try {
    inst.log('INFO', `[MCSP] 正在查询 ${t.label} ${inst.version} 下载信息…`);
    const info = await resolveDownload(inst.type, inst.version);
    inst.log('INFO', `[MCSP] 下载 ${info.name}${info.size ? ` (${(info.size / 1048576).toFixed(1)} MB)` : ''}`);
    await downloadTo(inst, info, t.installer ? [0, 60] : [0, 95]);

    if (t.installer) {
      inst.installProgress = 60;
      inst.emitState();
      await runInstaller(inst, info.name);
      finalizeInstallerLayout(inst, info.name);
    } else {
      inst.jar = info.name;
    }

    if (t.category === 'server') {
      fs.writeFileSync(path.join(inst.dir, 'eula.txt'),
        `# Accepted via MCSP by panel user on ${new Date().toISOString()}\neula=true\n`);
      inst.writeProps({
        'motd': motd || `${inst.name} — powered by MCSP`,
        'server-port': String(port || 25565),
        'max-players': '20',
        'gamemode': gamemode || 'survival',
        'difficulty': 'normal',
        'online-mode': 'true',
        'white-list': 'false',
        'view-distance': '10',
        'simulation-distance': '10',
        'spawn-protection': '16',
        'enable-command-block': 'false',
        'level-name': 'world',
      });
    }
    if (t.dataDir) fs.mkdirSync(path.join(inst.dir, t.dataDir), { recursive: true });

    inst.state = 'stopped';
    inst.installProgress = 100;
    inst.log('INFO', '[MCSP] 安装完成,可以启动了');
    saveRegistry();
  } catch (err) {
    inst.state = 'stopped';
    inst.installProgress = 0;
    inst.log('ERROR', `[MCSP] 安装失败: ${err.message}`);
  }
  inst.emitState();
  bus.broadcast('instances', {});
}

/* 克隆时不值得复制的目录:日志和崩溃报告属于"上一个实例的历史",
   缓存重新生成即可。整合包的 cache/ 可能有好几个 G。 */
const CLONE_SKIP = new Set(['logs', 'crash-reports', 'cache']);

/** 从 from 起找一个没被别的实例占用、也没在 LISTEN 的端口 */
function findFreePort(from) {
  const taken = new Set([...instances.values()].map((i) => parseInt(i.getProp('server-port'), 10)).filter(Boolean));
  for (let p = from; p < from + 200 && p < 65536; p++) {
    if (!taken.has(p) && !listeningPorts().has(p)) return p;
  }
  return null;
}

/**
 * 克隆实例:复制目录,换 id / 名字 / 端口,隧道配置不继承。
 * 要求源实例已停止 —— 边跑边拷世界会拿到一份撕裂的存档,
 * 那种损坏往往要等玩家进服才暴露。
 */
async function cloneInstance(src, { name, owner }) {
  const id = crypto.randomUUID().slice(0, 8);
  const inst = new Instance({
    ...src.meta(),
    id,
    name,
    owner,
    // 隧道配置带着 token / 固定远程端口,两个实例同时用会互相打架
    tunnel: undefined,
    wasRunning: false,
    createdAt: Date.now(),
  });

  await fsp.cp(src.dir, inst.dir, {
    recursive: true,
    filter: (from) => {
      const rel = path.relative(src.dir, from);
      return !rel || !CLONE_SKIP.has(rel.split(path.sep)[0]);
    },
  });

  // 端口必须换掉,否则两个实例永远只能开一个
  const srcPort = parseInt(src.getProp('server-port'), 10) || 25565;
  const port = findFreePort(srcPort + 1);
  if (port) {
    const props = inst.readProps();
    props['server-port'] = String(port);
    inst.writeProps(props);
  }
  inst.invalidatePropsCache();

  instances.set(id, inst);
  saveRegistry();
  inst.log('INFO', `[MCSP] 由「${src.name}」克隆而来${port ? `,端口已改为 ${port}` : ''}`);
  bus.broadcast('instances', {});
  return { inst, port };
}

/**
 * 重装 / 升级:只换服务端本体,世界、插件、server.properties 全部原样保留。
 *
 * 和 installInstance 的关键区别是**不碰 server.properties** —— 那里面有用户
 * 攒下来的全部配置,重装时按模板重写一遍等于把设置清空。
 * 失败时 type/version 保持原样(它们在下载成功之后才写回),实例还能按老版本启动。
 */
async function reinstallInstance(inst, { type, version, backup }) {
  const t = TYPES[type] || TYPES.paper;
  const oldJar = inst.jar;
  const oldDesc = `${(TYPES[inst.type] || {}).label || inst.type} ${inst.version}`;
  inst.state = 'installing';
  inst.installProgress = 0;
  inst.emitState();
  try {
    if (backup) {
      // 换版本可能是不可逆的(MC 不支持世界降级),动手前先留一份
      inst.log('INFO', '[MCSP] 重装前自动备份…');
      const b = await createBackup(inst, `before-${type}-${version}`);
      if (!b.ok) throw new Error(`重装前备份失败,已中止: ${b.error}`);
    }
    inst.log('INFO', `[MCSP] 开始重装:${oldDesc} → ${t.label} ${version}`);
    const info = await resolveDownload(type, version);
    inst.log('INFO', `[MCSP] 下载 ${info.name}${info.size ? ` (${(info.size / 1048576).toFixed(1)} MB)` : ''}`);
    await downloadTo(inst, info, t.installer ? [0, 60] : [0, 95]);

    if (t.installer) {
      inst.installProgress = 60;
      inst.emitState();
      await runInstaller(inst, info.name);
      finalizeInstallerLayout(inst, info.name);
    } else {
      inst.jar = info.name;
    }

    // 走到这里才算换成功,现在再写回元数据
    inst.type = type;
    inst.version = version;

    // 旧 jar 换了名字就删掉,否则目录里会越堆越多历史版本(还容易手动启错)
    if (oldJar && oldJar !== inst.jar && fs.existsSync(path.join(inst.dir, oldJar))) {
      fs.rmSync(path.join(inst.dir, oldJar), { force: true });
      inst.log('INFO', `[MCSP] 已移除旧服务端 ${oldJar}`);
    }
    // 代理换成服务端时,这两样此前不存在,补上;已存在则一概不动
    if (t.category === 'server') {
      const eula = path.join(inst.dir, 'eula.txt');
      if (!fs.existsSync(eula)) {
        fs.writeFileSync(eula, `# Accepted via MCSP on ${new Date().toISOString()}\neula=true\n`);
      }
      if (!fs.existsSync(inst.propsPath())) {
        inst.writeProps({ 'server-port': '25565', 'motd': inst.name, 'max-players': '20', 'level-name': 'world' });
      }
    }
    if (t.dataDir) fs.mkdirSync(path.join(inst.dir, t.dataDir), { recursive: true });

    inst.state = 'stopped';
    inst.installProgress = 100;
    inst.invalidatePropsCache();
    inst.log('INFO', `[MCSP] 重装完成:现在是 ${t.label} ${version},启动后生效`);
    saveRegistry();
  } catch (err) {
    inst.state = 'stopped';
    inst.installProgress = 0;
    inst.log('ERROR', `[MCSP] 重装失败: ${err.message}(实例仍为 ${oldDesc},可照常启动)`);
  }
  inst.emitState();
  bus.broadcast('instances', {});
}

module.exports = { instances, saveRegistry, loadRegistry, startMetricsLoop, resumeInstances, installInstance, reinstallInstance, cloneInstance };
