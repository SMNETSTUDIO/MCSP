/**
 * Instance:一个真实的 Minecraft 服务端目录 + 进程,
 * 以及与之绑定的独立内网穿透隧道进程。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { INSTANCES_DIR, DATA_DIR } = require('./config');
const { resolveJavaBin } = require('./java');
const { TYPES } = require('./servertypes');
const { ts, stripAnsi, readJson } = require('./utils');
const { componentBin, ensureSshKey, sshKeyPath, DEFAULT_TUNNEL } = require('./tunnels');
const { authlibJarPath, authlibInstalled } = require('./authlib');
const { mcPing } = require('./mcping');
const bus = require('./bus');

/* taskset 可用性(util-linux,Linux 标配);缺失时 CPU 限核降级为不限制 */
const TASKSET_OK = (() => { try { return spawnSync('taskset', ['-V']).status === 0; } catch { return false; } })();

class Instance {
  constructor(meta) {
    this.id = meta.id;
    this.name = meta.name;
    this.icon = meta.icon || '🌳';
    this.owner = meta.owner || 'admin';                   // 归属用户;旧实例默认归管理员
    this.type = TYPES[meta.type] ? meta.type : 'paper';   // 旧实例无 type,默认 paper
    this.version = meta.version;
    this.jar = meta.jar;
    this.xmx = meta.xmx || 2048;
    // 外置登录(authlib-injector):enabled + Yggdrasil API 地址
    this.yggdrasil = { enabled: false, url: '', ...(meta.yggdrasil || {}) };
    this.createdAt = meta.createdAt || Date.now();

    this.dir = path.join(INSTANCES_DIR, this.id);
    this.state = 'stopped'; // stopped | installing | starting | running | stopping
    this.installProgress = 0;
    this.startedAt = null;
    this.proc = null;
    this.logs = [];
    this.players = new Set();
    this.metrics = { cpu: 0, ram: 0, ramMax: this.xmx };
    this.metricsHistory = [];
    this._lastCpu = null;
    this._stopTimeout = null;

    this.tunnel = { ...DEFAULT_TUNNEL(), ...(meta.tunnel || {}) };
    this.tunnelProc = null;
    this.tunnelState = 'stopped'; // stopped | starting | running
    this.tunnelAddr = null;
    this.tunnelError = null;      // last failure reason, for the tunnel view
    this.tunnelClaim = null;      // playit 首次绑定链接
  }

  meta() {
    return { id: this.id, name: this.name, icon: this.icon, owner: this.owner, type: this.type, version: this.version, jar: this.jar, xmx: this.xmx, yggdrasil: this.yggdrasil, createdAt: this.createdAt, tunnel: this.tunnel };
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      icon: this.icon,
      type: this.type,
      owner: this.owner,
      state: this.state,
      installProgress: this.installProgress,
      version: this.version,
      xmx: this.xmx,
      yggdrasil: this.yggdrasil,
      port: this.getProp('server-port') || '25565',
      startedAt: this.startedAt,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
      playersOnline: this.players.size,
      maxPlayers: parseInt(this.getProp('max-players'), 10) || 20,
      metrics: this.metrics,
      motd: this.getProp('motd') || '',
      pid: this.proc ? this.proc.pid : null,
      tunnel: { type: this.tunnel.type, state: this.tunnelState, addr: this.tunnelAddr, error: this.tunnelError, claim: this.tunnelClaim },
    };
  }

  /* ── logging ── */

  log(level, message) {
    const entry = { time: ts(), level, message };
    this.logs.push(entry);
    if (this.logs.length > 1000) this.logs.shift();
    bus.broadcast('log', { iid: this.id, ...entry });
  }

  emitState() { bus.broadcast('state', this.snapshot()); }

  /* ── server.properties ── */

  propsPath() { return path.join(this.dir, 'server.properties'); }

  readProps() {
    const out = {};
    try {
      for (const line of fs.readFileSync(this.propsPath(), 'utf8').split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    } catch {}
    return out;
  }

  writeProps(props) {
    const lines = ['# Minecraft server properties', `# Managed by MCSP — ${new Date().toISOString()}`];
    for (const [k, v] of Object.entries(props)) lines.push(`${k}=${v}`);
    fs.writeFileSync(this.propsPath(), lines.join('\n') + '\n');
    this._propsCache = null;
  }

  getProp(key) {
    if (!this._propsCache || Date.now() - this._propsCacheAt > 5000) {
      this._propsCache = this.readProps();
      this._propsCacheAt = Date.now();
    }
    return this._propsCache[key];
  }

  invalidatePropsCache() { this._propsCache = null; }

  readServerJson(file) {
    const v = readJson(path.join(this.dir, file), []);
    return Array.isArray(v) ? v : [];
  }

  playerList() {
    const ops = new Set(this.readServerJson('ops.json').map((o) => o.name));
    return [...this.players].map((name) => ({ name, op: ops.has(name) }));
  }

  /* ── server lifecycle ── */

  /** 优雅停服命令:Velocity=shutdown,Bungee/Waterfall=end,其余=stop */
  get stopCmd() { return (TYPES[this.type] && TYPES[this.type].stopCommand) || 'stop'; }

  /** 新版 Forge/NeoForge 安装后无主 jar,以 @libraries/…/unix_args.txt 启动 */
  findArgsFile() {
    for (const base of ['net/minecraftforge/forge', 'net/neoforged/neoforge']) {
      const dir = path.join(this.dir, 'libraries', ...base.split('/'));
      let entries;
      try { entries = fs.readdirSync(dir); } catch { continue; }
      for (const v of entries) {
        const f = path.join(dir, v, 'unix_args.txt');
        if (fs.existsSync(f)) return path.relative(this.dir, f);
      }
    }
    return null;
  }

  start() {
    if (this.state !== 'stopped') return { ok: false, error: `实例当前状态为 ${this.state}` };
    const t = TYPES[this.type] || TYPES.paper;
    const argsFile = t.installer ? this.findArgsFile() : null;
    if (!argsFile && !fs.existsSync(path.join(this.dir, this.jar))) {
      return { ok: false, error: `找不到 ${this.jar},请重新安装实例` };
    }

    this.state = 'starting';
    this.emitState();
    // 按 MC 版本自动挑选 Java(托管版本优先);代理不依赖 MC 版本,直接用最新
    const javaBin = resolveJavaBin(t.category === 'proxy' ? null : this.version);
    // 外置登录:以 -javaagent 注入 authlib-injector,认证走自定义 Yggdrasil API
    let agentArgs = [];
    if (this.yggdrasil.enabled && this.yggdrasil.url) {
      if (!authlibInstalled()) {
        this.state = 'stopped';
        this.emitState();
        return { ok: false, error: 'authlib-injector.jar 未就绪,请在「设置」中重新保存外置登录配置以下载' };
      }
      agentArgs = [`-javaagent:${authlibJarPath()}=${this.yggdrasil.url}`];
      this.log('INFO', `[MCSP] 外置登录已启用 (authlib-injector → ${this.yggdrasil.url})`);
    }
    let args = [
      ...agentArgs,
      '-Xms512M', `-Xmx${this.xmx}M`,
      '-XX:+UseG1GC', '-Dterminal.jline=false', '-Dterminal.ansi=false',
      ...(argsFile ? [`@${argsFile}`] : ['-jar', this.jar]),
      ...(t.category === 'proxy' ? [] : ['nogui']),   // 代理不识别 nogui 参数
    ];
    // 普通用户的 CPU 配额:taskset 绑核,进程最多用到 maxCpuCores 个核(真实限制)
    let bin = javaBin;
    const { users } = require('./auth');   // 延迟加载,避免装配期循环依赖
    const ownerUser = users.find((u) => u.username === this.owner);
    const cores = ownerUser && ownerUser.role !== 'admin' && ownerUser.limits ? ownerUser.limits.maxCpuCores : 0;
    if (cores > 0 && cores < os.cpus().length && TASKSET_OK) {
      args = ['-c', `0-${cores - 1}`, javaBin, ...args];
      bin = 'taskset';
      this.log('INFO', `[MCSP] CPU 配额: 绑定 ${cores} 个核 (taskset -c 0-${cores - 1})`);
    }
    this.log('INFO', `[MCSP] 启动进程: ${javaBin} -Xms512M -Xmx${this.xmx}M ${argsFile ? '@' + argsFile : '-jar ' + this.jar}`);

    let proc;
    try {
      proc = spawn(bin, args, { cwd: this.dir, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      this.state = 'stopped';
      this.emitState();
      this.log('ERROR', `[MCSP] 无法启动 Java: ${err.message}`);
      return { ok: false, error: `无法启动 Java: ${err.message}` };
    }

    this.proc = proc;
    this._lastCpu = null;

    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = stripAnsi(buf.slice(0, i)).trimEnd();
        buf = buf.slice(i + 1);
        if (line) this._onServerLine(line);
      }
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);

    proc.on('error', (err) => {
      this.log('ERROR', `[MCSP] 进程错误: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(this._stopTimeout);
      const wasStopping = this.state === 'stopping';
      this.proc = null;
      this.state = 'stopped';
      this.startedAt = null;
      this.players.clear();
      this.metrics.cpu = 0;
      this.metrics.ram = 0;
      this.log(wasStopping || code === 0 ? 'INFO' : 'WARN',
        `[MCSP] 进程退出 (code=${code === null ? 'null' : code}${signal ? `, signal=${signal}` : ''})`);
      this.emitState();
      bus.broadcast('players', { iid: this.id, players: this.playerList() });
      if (this._restartAfterExit) {
        this._restartAfterExit = false;
        setTimeout(() => this.start(), 1000);
      }
    });

    return { ok: true };
  }

  _onServerLine(line) {
    // Paper format: [HH:MM:SS LEVEL]: message
    let time = ts(), level = 'INFO', message = line;
    const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\s+(\w+)\]:?\s?(.*)$/);
    if (m) { time = m[1]; level = m[2].toUpperCase(); message = m[3]; }
    const entry = { time, level, message };
    this.logs.push(entry);
    if (this.logs.length > 1000) this.logs.shift();
    bus.broadcast('log', { iid: this.id, ...entry });

    // Paper/Vanilla/Forge 等打 "Done (…)!";BungeeCord 只打 "Listening on …"(带自身时间前缀,不锚定)
    const isProxy = (TYPES[this.type] || {}).category === 'proxy';
    if (this.state === 'starting' && (/Done \([\d.]+s\)!/.test(message) || (isProxy && /Listening on /.test(message)))) {
      this.state = 'running';
      this.startedAt = Date.now();
      this.emitState();
    }
    let pm;
    if ((pm = message.match(/^(\w{1,16}) joined the game$/))) {
      this.players.add(pm[1]);
      bus.broadcast('players', { iid: this.id, players: this.playerList() });
      this.emitState();
    } else if ((pm = message.match(/^(\w{1,16}) left the game$/))) {
      this.players.delete(pm[1]);
      bus.broadcast('players', { iid: this.id, players: this.playerList() });
      this.emitState();
    }
  }

  stop() {
    if (!this.proc) return { ok: false, error: '实例未在运行' };
    if (this.state === 'stopping') return { ok: false, error: '正在停止中' };
    this.state = 'stopping';
    this.emitState();
    try { this.proc.stdin.write(this.stopCmd + '\n'); } catch {}
    // force kill if graceful stop hangs
    this._stopTimeout = setTimeout(() => {
      if (this.proc) {
        this.log('WARN', '[MCSP] 停止超时,强制终止进程');
        try { this.proc.kill('SIGKILL'); } catch {}
      }
    }, 30000);
    return { ok: true };
  }

  restart() {
    if (this.state !== 'running') return { ok: false, error: `实例当前状态为 ${this.state}` };
    this._restartAfterExit = true;
    return this.stop();
  }

  kill() {
    if (!this.proc) return { ok: false, error: '实例未在运行' };
    this.log('WARN', '[MCSP] 强制终止进程 (SIGKILL)');
    try { this.proc.kill('SIGKILL'); } catch {}
    return { ok: true };
  }

  command(raw) {
    const line = String(raw || '').trim().replace(/^\//, '');
    if (!line) return { ok: false, error: '命令不能为空' };
    if (!this.proc || (this.state !== 'running' && this.state !== 'starting')) {
      return { ok: false, error: '实例未在运行' };
    }
    this.log('INFO', `[MCSP] > /${line}`);
    try { this.proc.stdin.write(line + '\n'); } catch (err) {
      return { ok: false, error: `写入失败: ${err.message}` };
    }
    return { ok: true };
  }

  /* ── tunnel lifecycle(每实例独立)── */

  startTunnel() {
    if (this.tunnelProc) return { ok: false, error: '穿透已在运行' };
    const type = this.tunnel.type;
    const SSH_TYPES = ['pinggy', 'serveo'];
    if (!['ngrok', 'frpc', 'playit', 'bore', ...SSH_TYPES].includes(type)) {
      return { ok: false, error: '请先保存穿透配置(选择一种穿透方式)' };
    }
    const bin = SSH_TYPES.includes(type) ? 'ssh' : componentBin(type);
    if (!SSH_TYPES.includes(type) && !fs.existsSync(bin)) {
      return { ok: false, error: `${type} 尚未安装,请先在本页安装组件` };
    }
    const port = parseInt(this.getProp('server-port'), 10) || 25565;
    let SSH_OPTS = [];
    if (SSH_TYPES.includes(type)) {
      if (!ensureSshKey()) return { ok: false, error: '无法生成隧道专用 SSH 密钥' };
      SSH_OPTS = [
        '-T', '-p', '22',
        '-i', sshKeyPath(),
        '-o', 'IdentitiesOnly=yes',
        // 注意:不能加 BatchMode —— Serveo 依赖零提问的 keyboard-interactive 放行
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ServerAliveInterval=30',
        '-o', 'ExitOnForwardFailure=yes',
      ];
    }

    let proc;
    if (type === 'ngrok') {
      const token = String(this.tunnel.ngrok.authtoken || '').trim();
      if (!token) return { ok: false, error: '请先填写 ngrok Authtoken' };
      proc = spawn(bin, ['tcp', String(port), '--log', 'stdout', '--log-format', 'json'], {
        env: { ...process.env, NGROK_AUTHTOKEN: token },
      });
    } else if (type === 'playit') {
      const secretPath = path.join(DATA_DIR, `playit-${this.id}.toml`);
      proc = spawn(bin, ['--secret_path', secretPath, 'start'], { env: { ...process.env, NO_COLOR: '1', TERM: 'dumb' } });
      // agent 起来 12 秒内没报错也没在等绑定,视为已连接(隧道映射在 playit.gg 控制台配置)
      this._playitTimer = setTimeout(() => {
        if (this.tunnelProc === proc && this.tunnelState === 'starting' && !this.tunnelClaim && !this.tunnelError) {
          this.tunnelState = 'running';
          this.log('INFO', '[playit] ✔ agent 已连接。公网地址在 playit.gg 控制台的隧道页查看/配置(指向本机端口 ' + port + ')');
          this.emitState();
        }
      }, 12000);
    } else if (type === 'bore') {
      const b = this.tunnel.bore;
      const server = String(b.server || 'bore.pub').trim() || 'bore.pub';
      this._boreServer = server;
      const args = ['local', String(port), '--to', server];
      const remotePort = parseInt(b.remotePort, 10) || 0;
      if (remotePort > 0) args.push('--port', String(remotePort));
      proc = spawn(bin, args, {
        env: { ...process.env, ...(b.secret ? { BORE_SECRET: String(b.secret) } : {}) },
      });
    } else if (type === 'pinggy') {
      const token = String(this.tunnel.pinggy.token || '').trim();
      const sshOpts = [...SSH_OPTS];
      sshOpts[sshOpts.indexOf('22')] = '443';   // pinggy 走 443,防火墙友好
      proc = spawn('ssh', [...sshOpts, '-R', `0:127.0.0.1:${port}`, `${token ? token + '+' : ''}tcp@a.pinggy.io`]);
      if (!token) this.log('INFO', '[pinggy] 未填 token,免费匿名隧道约 60 分钟后断开;注册 pinggy.io 后填入 token 可延长');
    } else if (type === 'serveo') {
      // Serveo 按连接公钥识别账户;TCP 转发需先在 console.serveo.net 注册面板公钥
      let remotePort = parseInt(this.tunnel.serveo.remotePort, 10) || 0;
      if (!remotePort) remotePort = 30000 + Math.floor(Math.random() * 30000);
      this._serveoPort = remotePort;
      proc = spawn('ssh', [...SSH_OPTS, '-R', `${remotePort}:127.0.0.1:${port}`, 'serveo.net']);
    } else {
      const f = this.tunnel.frpc;
      if (!f.serverAddr) return { ok: false, error: '请先填写 frps 服务器地址' };
      const remotePort = parseInt(f.remotePort, 10) || port;
      const lines = [
        `serverAddr = "${f.serverAddr}"`,
        `serverPort = ${parseInt(f.serverPort, 10) || 7000}`,
      ];
      // frps-panel 等鉴权插件:user 标识用户,metadatas.token 携带该用户的密码
      if (f.user) lines.push(`user = "${f.user}"`);
      if (f.token) lines.push('auth.method = "token"', `auth.token = "${f.token}"`);
      if (f.metaToken) lines.push(`metadatas.token = "${f.metaToken}"`);
      lines.push(
        '',
        '[[proxies]]',
        `name = "mcsp-${this.id}"`,
        'type = "tcp"',
        'localIP = "127.0.0.1"',
        `localPort = ${port}`,
        `remotePort = ${remotePort}`,
      );
      const cfgPath = path.join(DATA_DIR, `frpc-${this.id}.toml`);
      fs.writeFileSync(cfgPath, lines.join('\n') + '\n');
      this._frpcPublic = `${f.serverAddr}:${remotePort}`;
      proc = spawn(bin, ['-c', cfgPath]);
    }

    this.tunnelProc = proc;
    this.tunnelState = 'starting';
    this.tunnelAddr = null;
    this.tunnelError = null;
    this.tunnelClaim = null;
    this._playitUdpWarned = false;
    this.emitState();
    this.log('INFO', `[${type}] 内网穿透启动中 (本地端口 ${port})`);

    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      // playit 的 TUI 用 \r 刷新状态行,按 \r 和 \n 都切分
      while ((i = buf.search(/[\r\n]/)) >= 0) {
        const line = stripAnsi(buf.slice(0, i)).trim();
        buf = buf.slice(i + 1);
        if (line) this._onTunnelLine(type, line);
      }
      // TUI 常见:状态行只重绘不换行 —— 缓冲里若已出现完整关键信息,直接消费
      if (buf.length > 8 && /playit\.gg\/claim\/|\.ply\.gg|\.joinmc\.link/i.test(buf)) {
        this._onTunnelLine(type, stripAnsi(buf).trim());
        buf = '';
      }
      if (buf.length > 8192) buf = buf.slice(-2048);
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (err) => this.log('ERROR', `[${type}] 进程错误: ${err.message}`));
    proc.on('exit', (code, signal) => {
      clearTimeout(this._playitTimer);
      const expected = this._tunnelStopping;
      this._tunnelStopping = false;
      this.tunnelProc = null;
      this.tunnelState = 'stopped';
      this.tunnelAddr = null;
      this.tunnelClaim = null;
      this.log(expected || code === 0 ? 'INFO' : 'WARN',
        `[${type}] 隧道进程退出 (code=${code === null ? 'null' : code}${signal ? `, signal=${signal}` : ''})`);
      this.emitState();
    });
    return { ok: true };
  }

  _onTunnelLine(type, line) {
    if (type === 'bore') {
      const m = line.match(/listening at [\w.-]+:(\d+)/i);
      if (m) {
        this.tunnelAddr = `${this._boreServer}:${m[1]}`;
        this.tunnelState = 'running';
        this.log('INFO', `[bore] ✔ 隧道已建立: ${this.tunnelAddr}`);
        this.emitState();
        this.scheduleTunnelCheck();
      } else if (/error|denied|refused|invalid secret/i.test(line)) {
        this.log('WARN', `[bore] ${line.slice(0, 200)}`);
        if (!this.tunnelAddr && !this.tunnelError) this.tunnelError = line.slice(0, 200);
      }
      return;
    }
    if (type === 'pinggy') {
      const m = line.match(/tcp:\/\/([\w.-]+:\d+)/i);
      if (m) {
        if (this.tunnelAddr !== m[1]) {
          this.tunnelAddr = m[1];
          this.tunnelState = 'running';
          this.log('INFO', `[pinggy] ✔ 隧道已建立: ${this.tunnelAddr}`);
          this.emitState();
          this.scheduleTunnelCheck();
        }
      } else if (/permission denied|connection (closed|refused)|timed out|denied/i.test(line)) {
        this.log('WARN', `[pinggy] ${line.slice(0, 200)}`);
        if (!this.tunnelAddr && !this.tunnelError) this.tunnelError = line.slice(0, 200);
      }
      return;
    }
    if (type === 'serveo') {
      const m = line.match(/Forwarding TCP connections? from ([\w.-]+)(?::(\d+))?/i);
      if (m) {
        this.tunnelAddr = `${m[1]}:${m[2] || this._serveoPort}`;
        this.tunnelState = 'running';
        this.log('INFO', `[serveo] ✔ 隧道已建立: ${this.tunnelAddr}`);
        this.emitState();
        this.scheduleTunnelCheck();
      } else if (/forwarding failed/i.test(line)) {
        this.log('WARN', `[serveo] ${line.slice(0, 200)}`);
        if (!this.tunnelError) this.tunnelError = '远程端口转发被拒绝:请确认已在 console.serveo.net 注册面板公钥(组件页可复制),或换一个远程端口';
      } else if (/permission denied|connection (closed|refused)|timed out/i.test(line)) {
        this.log('WARN', `[serveo] ${line.slice(0, 200)}`);
        if (!this.tunnelAddr && !this.tunnelError) this.tunnelError = line.slice(0, 200);
      }
      return;
    }
    if (type === 'playit') {
      const claim = line.match(/https:\/\/playit\.gg\/claim\/[\w-]+/);
      if (claim && this.tunnelClaim !== claim[0]) {
        this.tunnelClaim = claim[0];
        this.log('INFO', `[playit] 首次使用:请打开链接绑定账户 → ${claim[0]}`);
        this.emitState();
        return;
      }
      const addr = line.match(/([\w][\w-]*(?:\.[\w-]+)*\.(?:ply\.gg|joinmc\.link)(?::\d+)?)/i);
      if (addr) {
        if (this.tunnelAddr !== addr[1]) {
          this.tunnelAddr = addr[1];
          this.tunnelState = 'running';
          this.log('INFO', `[playit] ✔ 隧道地址: ${addr[1]}`);
          this.emitState();
        }
        return;
      }
      if (/Program approved/i.test(line)) {
        this.tunnelClaim = null;
        this.log('INFO', '[playit] ✔ 账户绑定成功,正在建立隧道连接…');
        this.emitState();
        return;
      }
      if (/FailedToConnect|Failed to setup tunnel client/i.test(line)) {
        // 精确诊断,允许覆盖之前捕获的通用杂讯
        if (!this._playitUdpWarned) {
          this._playitUdpWarned = true;
          this.tunnelError = 'agent 无法连接 playit 隧道服务器。playit 的隧道协议需要出站 UDP,请确认宿主机/防火墙放行出站 UDP;若网络环境封锁 UDP,请改用 frpc 或 ngrok(纯 TCP)';
          this.log('WARN', '[playit] 隧道连接失败 (FailedToConnect) — 出站 UDP 可能被防火墙拦截');
          if (this.tunnelState === 'running') this.tunnelState = 'starting';
          this.emitState();
        }
        return;
      }
      if (/agent (connected|running)|tunnel (running|accepted)|connected to tunnel server/i.test(line)) {
        if (this.tunnelState === 'starting' && !this.tunnelClaim) {
          this.tunnelState = 'running';
          this.log('INFO', '[playit] ✔ agent 已连接');
          this.emitState();
        }
      } else if (/^(Error|MSG):/i.test(line) && line.length < 160) {
        // 只捕获规整的错误行,忽略 TUI 状态行拼接出的杂讯
        this.log('WARN', `[playit] ${line}`);
        if (!this.tunnelAddr && !this.tunnelError) this.tunnelError = line;
      }
      return;
    }
    if (type === 'ngrok') {
      let obj = null;
      try { obj = JSON.parse(line); } catch {}
      if (!obj) return;
      if (obj.msg === 'started tunnel' && obj.url) {
        this.tunnelAddr = obj.url.replace(/^tcp:\/\//, '');
        this.tunnelState = 'running';
        this.log('INFO', `[ngrok] ✔ 隧道已建立: ${this.tunnelAddr}`);
        this.emitState();
        this.scheduleTunnelCheck();
      } else if (obj.lvl === 'warn' || obj.lvl === 'eror' || obj.lvl === 'crit') {
        this.log('WARN', `[ngrok] ${obj.msg}${obj.err ? ` — ${obj.err}` : ''}`);
        if (obj.err && !this.tunnelAddr) {
          // 提炼可读的失败原因(如 ERR_NGROK_8013 免费账户需绑卡)
          const err = String(obj.err);
          const code = (err.match(/ERR_NGROK_\d+/) || [])[0];
          let friendly = err.split('\n')[0].replace(/^failed to start tunnel:\s*/i, '');
          if (code === 'ERR_NGROK_8013') {
            friendly = '免费账户使用 TCP 隧道需先在 ngrok 后台绑定一张银行卡(仅验证,不扣费):dashboard.ngrok.com/settings#id-verification';
          } else if (code === 'ERR_NGROK_105' || /authentication failed/i.test(err)) {
            friendly = 'Authtoken 无效或已过期,请到 dashboard.ngrok.com 重新复制';
          }
          this.tunnelError = code ? `${friendly} (${code})` : friendly.slice(0, 200);
        }
      } else if (obj.msg === 'client session established') {
        this.log('INFO', '[ngrok] 已连接 ngrok 服务器');
      }
    } else {
      // frpc plain logs
      if (/start proxy success/i.test(line)) {
        this.tunnelAddr = this._frpcPublic;
        this.tunnelState = 'running';
        this.log('INFO', `[frpc] ✔ 隧道已建立: ${this.tunnelAddr}`);
        this.emitState();
        this.scheduleTunnelCheck();
      } else if (/login to server success/i.test(line)) {
        this.log('INFO', '[frpc] 已连接 frps 服务器');
      } else if (/error|failed|fatal/i.test(line)) {
        this.log('WARN', `[frpc] ${line.replace(/^\d{4}[-/.:\d\s]+/, '')}`);
        if (!this.tunnelAddr && /login to the server failed|connect to server error/i.test(line)) {
          this.tunnelError = '无法连接 frps 服务器,请检查地址 / 端口 / token 是否正确';
        } else if (!this.tunnelAddr && /port already used|proxy .* already exists/i.test(line)) {
          this.tunnelError = '远程端口已被占用或代理名冲突,请换一个远程端口';
        }
      }
    }
  }

  stopTunnel() {
    if (!this.tunnelProc) return { ok: false, error: '穿透未在运行' };
    this._tunnelStopping = true;
    try { this.tunnelProc.kill('SIGTERM'); } catch {}
    return { ok: true };
  }

  /* 隧道建立 4 秒后自动做一次真实连通性检测 */
  scheduleTunnelCheck() {
    clearTimeout(this._checkTimer);
    this._checkTimer = setTimeout(async () => {
      if (!this.tunnelAddr || this.tunnelState !== 'running') return;
      const [host, portStr] = this.tunnelAddr.split(':');
      const r = await mcPing(host, parseInt(portStr, 10) || 25565);
      if (!this.tunnelAddr || this.tunnelState !== 'running') return;
      if (r.ok) {
        this.log('INFO', `[MCSP] ✔ 公网连通性验证通过: ${this.tunnelAddr}${r.version ? ` (${r.version})` : ''}`);
        if (this.tunnelError && this.tunnelError.includes('连通性')) this.tunnelError = null;
      } else {
        this.tunnelError = `隧道显示已建立,但公网连通性验证失败:${r.error}。可能原因:实例未启动 / 服务商免费档未真正转发数据(如 Serveo)/ 服务商屏蔽探测`;
        this.log('WARN', `[MCSP] ✘ 公网连通性验证失败: ${this.tunnelAddr} — ${r.error}`);
      }
      this.emitState();
    }, 4000);
  }

  /* ── metrics from /proc ── */

  tickMetrics() {
    if (this.proc && this.proc.pid) {
      try {
        const stat = fs.readFileSync(`/proc/${this.proc.pid}/stat`, 'utf8');
        const parts = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        const ticks = parseInt(parts[11], 10) + parseInt(parts[12], 10); // utime + stime
        const now = Date.now();
        if (this._lastCpu) {
          const dTicks = ticks - this._lastCpu.ticks;
          const dMs = now - this._lastCpu.at;
          this.metrics.cpu = Math.max(0, Math.round((dTicks / 100) / (dMs / 1000) * 100));
        }
        this._lastCpu = { ticks, at: now };
        const status = fs.readFileSync(`/proc/${this.proc.pid}/status`, 'utf8');
        const rss = status.match(/VmRSS:\s+(\d+) kB/);
        if (rss) this.metrics.ram = Math.round(parseInt(rss[1], 10) / 1024);
      } catch { /* process just exited */ }
    } else {
      this.metrics.cpu = 0;
      this.metrics.ram = 0;
    }
    this.metrics.ramMax = this.xmx;
    const point = { t: Date.now(), cpu: this.metrics.cpu, ram: this.metrics.ram };
    this.metricsHistory.push(point);
    if (this.metricsHistory.length > 150) this.metricsHistory.shift();
    if (this.proc || this.metricsHistory.length < 3 || this.metricsHistory[this.metricsHistory.length - 2].ram !== 0) {
      bus.broadcast('metrics', { iid: this.id, ...point });
    }
  }
}

module.exports = { Instance };
