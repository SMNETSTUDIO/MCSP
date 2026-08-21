/** 实例注册表:加载/持久化实例元数据,新实例的下载安装流程 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { REGISTRY_FILE } = require('./config');
const { readJson, writeJson } = require('./utils');
const { Instance } = require('./instance');
const { TYPES, resolveDownload } = require('./servertypes');
const { resolveJavaBin } = require('./java');
const bus = require('./bus');

const instances = new Map();

function saveRegistry() {
  writeJson(REGISTRY_FILE, [...instances.values()].map((i) => i.meta()));
}

function loadRegistry() {
  for (const meta of readJson(REGISTRY_FILE, [])) {
    const inst = new Instance(meta);
    if (fs.existsSync(inst.dir)) instances.set(inst.id, inst);
  }
  bus.resolveOwner = (iid) => { const i = instances.get(iid); return i ? i.owner : null; };
  saveRegistry();
}

function startMetricsLoop() {
  setInterval(() => { for (const inst of instances.values()) inst.tickMetrics(); }, 2000);
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

module.exports = { instances, saveRegistry, loadRegistry, startMetricsLoop, installInstance };
