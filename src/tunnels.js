/**
 * 穿透组件管理:ngrok / frpc / playit / bore 二进制下载安装,
 * SSH 类隧道(Pinggy / Serveo)的专用密钥。
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { BIN_DIR, DATA_DIR, TUNNEL_ARCH } = require('./config');
const { downloadFile, runCmd, githubLatestTag } = require('./utils');
const bus = require('./bus');

const componentInstalls = new Map(); // name -> progress %

function componentBin(name) { return path.join(BIN_DIR, name); }

const VERSION_ARGS = { ngrok: 'version', frpc: '--version', playit: 'version', bore: '--version' };

/** 面板隧道专用 SSH 密钥;返回公钥内容(用于注册到 Serveo 等服务) */
function ensureSshKey() {
  const sshDir = path.join(DATA_DIR, 'ssh');
  const keyPath = path.join(sshDir, 'id_ed25519');
  try {
    if (!fs.existsSync(keyPath)) {
      fs.mkdirSync(sshDir, { recursive: true });
      execSync(`ssh-keygen -t ed25519 -N "" -f "${keyPath}" -C mcsp-tunnel`, { timeout: 15000 });
    }
    return fs.readFileSync(keyPath + '.pub', 'utf8').trim();
  } catch {
    return null;
  }
}

function sshKeyPath() { return path.join(DATA_DIR, 'ssh', 'id_ed25519'); }

function componentInfo() {
  const out = { arch: TUNNEL_ARCH };
  for (const name of ['ngrok', 'frpc', 'playit', 'bore']) {
    const bin = componentBin(name);
    let version = null;
    if (fs.existsSync(bin)) {
      try {
        version = execSync(`${bin} ${VERSION_ARGS[name]} 2>&1`, { timeout: 5000 })
          .toString().trim().split('\n')[0].slice(0, 60);
      } catch {}
    }
    out[name] = {
      installed: fs.existsSync(bin),
      version,
      installing: componentInstalls.has(name),
      progress: componentInstalls.get(name) || 0,
    };
  }
  // SSH 类隧道(Pinggy / Serveo)复用系统 ssh 客户端
  try {
    const v = execSync('ssh -V 2>&1', { timeout: 5000 }).toString().trim().split(',')[0];
    out.ssh = { installed: true, version: v, builtin: true, pubkey: ensureSshKey() };
  } catch {
    out.ssh = { installed: false, version: null, builtin: true };
  }
  return out;
}

async function installComponent(name) {
  if (componentInstalls.has(name)) throw new Error('该组件正在安装中');
  componentInstalls.set(name, 0);
  bus.broadcast('components', componentInfo());
  const notify = (pct) => {
    componentInstalls.set(name, pct);
    if (pct % 5 === 0) bus.broadcast('components', componentInfo());
  };
  const tmp = path.join(BIN_DIR, `.${name}.download`);
  try {
    if (name === 'ngrok') {
      const url = `https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-${TUNNEL_ARCH}.tgz`;
      await downloadFile(url, tmp, notify);
      await runCmd('tar', ['xzf', tmp, '-C', BIN_DIR]);
    } else if (name === 'frpc') {
      const ver = await githubLatestTag('fatedier/frp', '0.61.1');
      const dirName = `frp_${ver}_linux_${TUNNEL_ARCH}`;
      await downloadFile(`https://github.com/fatedier/frp/releases/download/v${ver}/${dirName}.tar.gz`, tmp, notify);
      await runCmd('tar', ['xzf', tmp, '-C', BIN_DIR]);
      fs.copyFileSync(path.join(BIN_DIR, dirName, 'frpc'), componentBin('frpc'));
      fs.rmSync(path.join(BIN_DIR, dirName), { recursive: true, force: true });
    } else if (name === 'playit') {
      // 固定使用 0.15 经典独立版:新版 playitd 是纯守护进程,需配套官方前端
      // 走 IPC 提供密钥,无法在无头面板中完成绑定流程
      const ver = '0.15.26';
      const asset = `playit-linux-${TUNNEL_ARCH === 'arm64' ? 'aarch64' : 'amd64'}`;
      await downloadFile(`https://github.com/playit-cloud/playit-agent/releases/download/v${ver}/${asset}`, tmp, notify);
      fs.copyFileSync(tmp, componentBin('playit'));
    } else if (name === 'bore') {
      const ver = await githubLatestTag('ekzhang/bore', '0.6.0');
      const asset = `bore-v${ver}-${TUNNEL_ARCH === 'arm64' ? 'aarch64' : 'x86_64'}-unknown-linux-musl.tar.gz`;
      await downloadFile(`https://github.com/ekzhang/bore/releases/download/v${ver}/${asset}`, tmp, notify);
      await runCmd('tar', ['xzf', tmp, '-C', BIN_DIR]);   // 包内即 bore 单文件
    } else {
      throw new Error('未知组件');
    }
    fs.chmodSync(componentBin(name), 0o755);
  } finally {
    fs.rmSync(tmp, { force: true });
    componentInstalls.delete(name);
    bus.broadcast('components', componentInfo());
  }
}

const DEFAULT_TUNNEL = () => ({
  type: 'none',
  ngrok: { authtoken: '' },
  frpc: { serverAddr: '', serverPort: 7000, token: '', user: '', metaToken: '', remotePort: 0 },
  playit: {},   // 密钥由 agent 自管,存于 data/playit-<iid>.toml
  bore: { server: 'bore.pub', secret: '', remotePort: 0 },
  pinggy: { token: '' },
  serveo: { remotePort: 0 },
});

module.exports = { componentBin, componentInfo, installComponent, ensureSshKey, sshKeyPath, DEFAULT_TUNNEL };
