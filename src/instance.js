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
const notify = require('./notify');

/* taskset 可用性(util-linux,Linux 标配);缺失时 CPU 限核降级为不限制 */
const TASKSET_OK = (() => { try { return spawnSync('taskset', ['-V']).status === 0; } catch { return false; } })();

/* 崩溃自动重启:窗口内最多重启这么多次,超了就停手。
   端口被占、jar 损坏这类"起来就死"的故障否则会无限重启刷屏,
   还会把真正的报错顶出日志缓冲区。

   三个参数都在系统设置里(thresholds),每次崩溃现读 —— 重度模组服崩得比原版
   勤得多,固定 3 次/10 分钟对它们太紧。lazy require 是为了避开
   settings → auth → … 与本模块的加载顺序纠缠。 */
function crashCfg() {
  const t = require('./settings').get().thresholds;
  return {
    windowMs: t.crashWindowMin * 60_000,
    maxRestarts: t.crashMaxRestarts,
    delayMs: t.crashRestartDelaySec * 1000,
  };
}

/* 落盘日志单文件上限,超了滚一份 .1(总占用 = 2 倍)。
   16 MB 约合几十万行,够覆盖一次完整的排查窗口 */
const LOG_FILE_MAX_BYTES = Math.max(1, parseInt(process.env.MCSP_LOG_FILE_MB, 10) || 16) * 1048576;

/* 每个实例最多留几次崩溃现场。每条含 200 行 tail(约 30 KB),20 条够回溯
   一整轮"改配置→崩→再改"的排查过程,又不会把 data/ 撑大 */
const CRASH_HISTORY_MAX = 20;

/* 控制台内存缓冲行数。原来是 1000,查一次崩溃根本不够翻 ——
   一行日志对象约 150 字节,5000 行 × 几十个实例仍是几十 MB 量级,可接受。 */
const LOG_BUFFER_LINES = Math.max(500, parseInt(process.env.MCSP_LOG_LINES, 10) || 5000);

/* 指标两档保留:
   · 秒级 150 点 × 2s ≈ 5 分钟,给实时曲线用;
   · 分钟级 1440 点 = 24 小时,回答"昨晚是不是内存打满了"。
   分钟档存的是这一分钟的均值 + 峰值 —— 只存均值会把瞬时尖峰抹平,
   而尖峰恰恰是排查 OOM 时最要看的东西。都在内存里,面板重启即丢。 */
const METRICS_LIVE_POINTS = 150;
const METRICS_MINUTE_POINTS = 1440;

/* 面板正在退出:此时子进程被挨个 stop 掉是预期行为,不能当崩溃处理 */
const panel = { shuttingDown: false };

/**
 * 自定义 JVM 参数的白名单式校验,返回 { args, error }。
 *
 * 参数是拼进 spawn 的 argv 数组、不过 shell 的,所以没有命令注入面;
 * 真正要挡的是这两类:
 *   · -Xmx / -XX:MaxHeapSize / -XX:MaxRAMPercentage —— 内存配额就是靠 -Xmx 落地的,
 *     放行等于让普通用户自己改配额;而且堆上限有两个来源本身就容易搞混。
 *   · -jar / -cp / @file —— 会改变到底启动了什么,让启动命令不再可预测。
 * 其余 -X / -XX / -D 一律放行:玩家要贴的 Aikar's Flags 就是这些。
 */
function sanitizeJvmArgs(raw) {
  const text = String(raw || '').replace(/[\r\n]+/g, ' ').trim();
  if (!text) return { args: [], error: null };
  if (text.length > 2000) return { args: [], error: 'JVM 参数过长(上限 2000 字符)' };
  const args = text.split(/\s+/).filter(Boolean);
  if (args.length > 80) return { args: [], error: 'JVM 参数过多(上限 80 个)' };
  for (const a of args) {
    if (!a.startsWith('-')) return { args: [], error: `参数必须以 - 开头: ${a}` };
    if (/^-Xmx/i.test(a) || /^-XX:MaxHeapSize/i.test(a) || /^-XX:MaxRAMPercentage/i.test(a)) {
      return { args: [], error: `内存上限请用上面的「内存上限 -Xmx」字段设置,不要写在这里: ${a}` };
    }
    if (/^-(jar|cp|classpath)$/i.test(a)) return { args: [], error: `不允许覆盖启动目标: ${a}` };
  }
  return { args, error: null };
}

/**
 * 本机正在 LISTEN 的 TCP 端口。
 * 读 /proc 而不是试着 bind 一下:bind 是异步的,而 start() 是同步返回 {ok,error} 的,
 * 改成异步要动所有调用方。面板本来就只跑 Linux(指标也读 /proc),这里代价最小。
 */
function listeningPorts() {
  const ports = new Set();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const col = line.trim().split(/\s+/);
      if (col.length < 4 || col[3] !== '0A') continue;   // st=0A 即 TCP_LISTEN
      const hex = col[1].split(':')[1];
      if (hex) ports.add(parseInt(hex, 16));
    }
  }
  return ports;
}

class Instance {
  constructor(meta) {
    this.id = meta.id;
    this.name = meta.name;
    this.icon = meta.icon || '🌳';
    this.owner = meta.owner || 'admin';                   // 归属用户;旧实例默认归管理员
    // 协作者:能操作这个实例,但不能删实例、也不能改协作者名单。
    // 配额始终算在 owner 头上 —— 否则拉个小号当协作者就能绕开自己的配额
    this.collaborators = Array.isArray(meta.collaborators) ? meta.collaborators.filter((x) => typeof x === 'string') : [];
    this.type = TYPES[meta.type] ? meta.type : 'paper';   // 旧实例无 type,默认 paper
    this.version = meta.version;
    this.jar = meta.jar;
    this.xmx = meta.xmx || 2048;
    // 外置登录(authlib-injector):enabled + Yggdrasil API 地址
    this.yggdrasil = { enabled: false, url: '', ...(meta.yggdrasil || {}) };
    // 崩溃自动重启,默认开;老实例注册表里没这个字段,按开处理
    this.autoRestart = meta.autoRestart !== false;
    // 面板重启后恢复,默认开;只有 wasRunning 为真才会真的拉起来,
    // 所以用户主动停掉的实例不会因为面板重启又自己跑起来
    this.autoStart = meta.autoStart !== false;
    this.jvmArgs = typeof meta.jvmArgs === 'string' ? meta.jvmArgs : '';
    this.wasRunning = !!meta.wasRunning;
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
    this.metricsMinutes = [];         // 分钟级聚合,24 小时
    this._minuteBucket = null;
    this._lastCpu = null;
    this._stopTimeout = null;
    this._crashTimes = [];            // 窗口内的崩溃时刻,用来判断是不是在打转
    this._crashTimer = null;          // 待触发的自动重启
    this._killedByUser = false;       // kill() 置位:强杀是用户要的,不算崩溃
    this.autoRestartBlocked = false;  // 触发风暴保护后置位,手动启动时清掉
    this.lastExitCode = null;         // 最近一次进程退出码/信号,崩溃归档时记进去
    this.lastSignal = null;
    // 崩溃历史落盘(data/crashes/<iid>.json):面板重启后还能查上次为什么崩
    this.crashes = readJson(path.join(DATA_DIR, 'crashes', `${this.id}.json`), []);

    this.tunnel = { ...DEFAULT_TUNNEL(), ...(meta.tunnel || {}) };
    this.tunnelProc = null;
    this.tunnelState = 'stopped'; // stopped | starting | running
    this.tunnelAddr = null;
    this.tunnelError = null;      // last failure reason, for the tunnel view
    this.tunnelClaim = null;      // playit 首次绑定链接
  }

  meta() {
    return { id: this.id, name: this.name, icon: this.icon, owner: this.owner, collaborators: this.collaborators, type: this.type, version: this.version, jar: this.jar, xmx: this.xmx, yggdrasil: this.yggdrasil, autoRestart: this.autoRestart, autoStart: this.autoStart, wasRunning: this.wasRunning, jvmArgs: this.jvmArgs, createdAt: this.createdAt, tunnel: this.tunnel };
  }

  snapshot() {
    return {
      id: this.id,
      name: this.name,
      icon: this.icon,
      type: this.type,
      owner: this.owner,
      collaborators: this.collaborators,
      state: this.state,
      installProgress: this.installProgress,
      version: this.version,
      xmx: this.xmx,
      yggdrasil: this.yggdrasil,
      autoRestart: this.autoRestart,
      autoRestartBlocked: this.autoRestartBlocked,
      autoStart: this.autoStart,
      jvmArgs: this.jvmArgs,
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

  /** 谁能操作这个实例:管理员、主人、协作者 */
  canAccess(user) {
    if (!user) return false;
    return user.role === 'admin' || user.username === this.owner || this.collaborators.includes(user.username);
  }

  /* ── logging ── */

  log(level, message) {
    const entry = { time: ts(), level, message };
    this.logs.push(entry);
    if (this.logs.length > LOG_BUFFER_LINES) this.logs.shift();
    this._appendLogFile(entry);
    bus.broadcast('log', { iid: this.id, ...entry });
  }

  /**
   * 控制台日志落盘(功能 4)。
   *
   * 内存缓冲只有 5000 行且面板一重启就没 —— 偏偏"面板重启前那台服务器
   * 到底怎么了"正是最常要查的。服务端自己的 logs/latest.log 也不够:
   * 它不含面板自己打的那些 [MCSP] 行(自动重启、配额拦截、隧道状态),
   * 而排查往往就卡在这些行上。
   *
   * 写在实例目录的 logs/mcsp-console.log,超过上限就滚一份 .1 ——
   * 只留一代,再多是在替用户做长期归档的决定,那是备份该管的事。
   * 用同步 append:日志量小(一行几十字节),但顺序不能乱。
   */
  _appendLogFile(entry) {
    try {
      const dir = path.join(this.dir, 'logs');
      const file = path.join(dir, 'mcsp-console.log');
      if (this._logBytes === undefined) {
        fs.mkdirSync(dir, { recursive: true });
        try { this._logBytes = fs.statSync(file).size; } catch { this._logBytes = 0; }
      }
      if (this._logBytes >= LOG_FILE_MAX_BYTES) {
        try { fs.renameSync(file, `${file}.1`); } catch {}
        this._logBytes = 0;
      }
      const line = `${entry.time} [${entry.level}] ${entry.message}\n`;
      fs.appendFileSync(file, line);
      this._logBytes += Buffer.byteLength(line);
    } catch {
      // 磁盘满/目录被删都不该让实例挂掉。这里不能再调 this.log —— 会无限递归
    }
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

  /** auto=true 表示这次不是人点的(崩溃重启 / 开机恢复),不清空崩溃计数(否则风暴保护永远攒不满) */
  start({ auto = false } = {}) {
    if (this.state !== 'stopped') return { ok: false, error: `实例当前状态为 ${this.state}` };
    if (!auto) this.cancelAutoRestart();     // 手动启动 = 用户已介入,计数与封禁一并清零
    const t = TYPES[this.type] || TYPES.paper;
    const argsFile = t.installer ? this.findArgsFile() : null;
    if (!argsFile && !fs.existsSync(path.join(this.dir, this.jar))) {
      return { ok: false, error: `找不到 ${this.jar},请重新安装实例` };
    }
    const portErr = this._portConflict();
    if (portErr) {
      this.log('ERROR', `[MCSP] 启动中止: ${portErr}`);
      return { ok: false, error: portErr };
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
    // 自定义参数排在默认值之后:同一个 flag 出现两次时 HotSpot 取最后一个,
    // 所以用户写 -Xms4G / 换 GC 都能盖掉默认值。-Xmx 在校验里已经禁掉了(配额靠它)。
    const custom = sanitizeJvmArgs(this.jvmArgs).args;
    const hasXms = custom.some((a) => /^-Xms/i.test(a));
    let args = [
      ...agentArgs,
      ...(hasXms ? [] : ['-Xms512M']), `-Xmx${this.xmx}M`,
      '-XX:+UseG1GC', '-Dterminal.jline=false', '-Dterminal.ansi=false',
      ...custom,
      ...(argsFile ? [`@${argsFile}`] : ['-jar', this.jar]),
      ...(t.category === 'proxy' ? [] : ['nogui']),   // 代理不识别 nogui 参数
    ];
    if (custom.length) this.log('INFO', `[MCSP] 自定义 JVM 参数 (${custom.length} 个): ${custom.join(' ')}`);
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
    // 进程真的起来了才记"该开着":否则端口占用/缺 jar 这种失败也会被记下,
    // 面板下次重启还会徒劳地恢复它一遍
    this._setWasRunning(true);

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
      // spawn 本身失败时(最常见:没装 Java,ENOENT)Node 不保证还会发 'exit',
      // 不自己收尾的话实例会永远卡在 starting —— 既停不掉也起不来。
      // proc.pid 为空即代表根本没起来,和"起来了再崩"要分开处理。
      if (this.proc === proc && !proc.pid) {
        this.proc = null;
        this.state = 'stopped';
        this.startedAt = null;
        this._setWasRunning(false);      // 起都没起来,别让面板重启后还去恢复它
        this.emitState();
      }
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(this._stopTimeout);
      const wasStopping = this.state === 'stopping';
      const killedByUser = this._killedByUser;
      this._killedByUser = false;
      this.proc = null;
      this.state = 'stopped';
      this.startedAt = null;
      this.players.clear();
      this.metrics.cpu = 0;
      this.metrics.ram = 0;
      this.lastExitCode = code;
      this.lastSignal = signal;
      this.log(wasStopping || code === 0 ? 'INFO' : 'WARN',
        `[MCSP] 进程退出 (code=${code === null ? 'null' : code}${signal ? `, signal=${signal}` : ''})`);
      this.emitState();
      bus.broadcast('players', { iid: this.id, players: this.playerList() });
      if (this._restartAfterExit) {
        this._restartAfterExit = false;
        setTimeout(() => {
          const r = this.start({ auto: true });
          if (!r.ok) this.log('ERROR', `[MCSP] 重启失败: ${r.error}`);
        }, 1000);
        return;
      }
      // 崩溃 = 没人要它停,而且退出码不为 0。
      // code === 0 说明服务端自己干净地关了(比如有人在控制台敲了 stop),那是用户的意思,别跟他对着干。
      const crashed = !wasStopping && !killedByUser && !panel.shuttingDown && code !== 0;
      if (crashed) this._onCrash();
    });

    return { ok: true };
  }

  /** 崩溃后按窗口计数决定要不要重来一次 */
  /** 把秒级采样折进当前分钟桶;跨分钟时结算出一条分钟级记录 */
  _rollMinute(point) {
    const minute = Math.floor(point.t / 60000) * 60000;
    const b = this._minuteBucket;
    if (b && b.minute !== minute) {
      this.metricsMinutes.push({
        t: b.minute,
        cpu: Math.round(b.cpuSum / b.n),
        ram: Math.round(b.ramSum / b.n),
        cpuPeak: b.cpuPeak,
        ramPeak: b.ramPeak,
      });
      if (this.metricsMinutes.length > METRICS_MINUTE_POINTS) this.metricsMinutes.shift();
      this._minuteBucket = null;
    }
    if (!this._minuteBucket) {
      this._minuteBucket = { minute, n: 0, cpuSum: 0, ramSum: 0, cpuPeak: 0, ramPeak: 0 };
    }
    const cur = this._minuteBucket;
    cur.n++;
    cur.cpuSum += point.cpu;
    cur.ramSum += point.ram;
    cur.cpuPeak = Math.max(cur.cpuPeak, point.cpu);
    cur.ramPeak = Math.max(cur.ramPeak, point.ram);
  }

  _onCrash() {
    if (!this.autoRestart) return;
    const { windowMs, maxRestarts, delayMs } = crashCfg();
    const windowMin = Math.round(windowMs / 60000);
    // 崩溃报告落盘要赶在自动重启之前:重启会往 crash-reports/ 里再写一份,
    // 也会把内存日志缓冲刷走 —— 这一刻的现场是最全的
    this._captureCrash();
    if (maxRestarts === 0) {
      this.autoRestartBlocked = true;
      this.log('ERROR', '[MCSP] 崩溃自动重启已在系统设置中关闭,实例保持停止');
      this.emitState();
      return;
    }
    const now = Date.now();
    this._crashTimes = this._crashTimes.filter((t) => now - t < windowMs);
    this._crashTimes.push(now);

    if (this._crashTimes.length > maxRestarts) {
      this.autoRestartBlocked = true;
      this.log('ERROR', `[MCSP] ${windowMin} 分钟内异常退出 ${this._crashTimes.length} 次,已停止自动重启 —— 请查日志排查后手动启动`);
      notify.emit('restartBlocked', {
        title: `实例「${this.name}」已停止自动重启`,
        text: `${windowMin} 分钟内异常退出 ${this._crashTimes.length} 次,面板已放弃自动拉起。\n`
          + `最后几行日志:\n` + this.logs.slice(-6).map((l) => `${l.level} ${l.message}`).join('\n'),
        dedupeKey: this.id,
      });
      this.emitState();
      return;
    }
    this.log('WARN', `[MCSP] 检测到异常退出,${delayMs / 1000} 秒后自动重启 (${this._crashTimes.length}/${maxRestarts})`);
    notify.emit('crash', {
      title: `实例「${this.name}」异常退出`,
      text: `${delayMs / 1000} 秒后将自动重启(第 ${this._crashTimes.length}/${maxRestarts} 次)。\n`
        + this.logs.slice(-6).map((l) => `${l.level} ${l.message}`).join('\n'),
      dedupeKey: this.id,
    });
    this._crashTimer = setTimeout(() => {
      this._crashTimer = null;
      if (this.state !== 'stopped') return;    // 这几秒里用户可能已经自己启动了
      const r = this.start({ auto: true });
      if (!r.ok) this.log('ERROR', `[MCSP] 自动重启失败: ${r.error}`);
    }, delayMs);
  }

  /**
   * 崩溃现场存档(功能 3)。存两样东西,因为它们回答不同的问题:
   *   · tail:面板内存缓冲的最后 200 行 —— 崩在启动阶段、还没来得及写
   *     crash-reports/ 的场景(端口占用、JVM 参数写错)只有这个有用。
   *   · report:服务端自己写的 crash-reports/*.txt,取退出前后最新的那份 ——
   *     真正的 Java 堆栈在这里面。
   * 只记路径不复制文件:一份 crash report 几百 KB,复制一遍纯属浪费磁盘。
   */
  _captureCrash() {
    try {
      const dir = path.join(this.dir, 'crash-reports');
      let report = null;
      try {
        const newest = fs.readdirSync(dir)
          .filter((f) => f.endsWith('.txt'))
          .map((f) => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)[0];
        // 只认这次崩溃前后 2 分钟内写的,否则会把上个月的旧报告当成本次现场
        if (newest && Date.now() - newest.m < 120_000) report = newest.f;
      } catch { /* 没有 crash-reports 目录是常态 */ }

      this.crashes.unshift({
        at: Date.now(),
        exitCode: this.lastExitCode ?? null,
        signal: this.lastSignal ?? null,
        report,
        tail: this.logs.slice(-200).map((l) => `${l.time} ${l.level} ${l.message}`),
      });
      this.crashes.length = Math.min(this.crashes.length, CRASH_HISTORY_MAX);
      this._saveCrashes();
    } catch (err) {
      this.log('WARN', `[MCSP] 崩溃现场记录失败: ${err.message}`);
    }
  }

  _crashFile() { return path.join(DATA_DIR, 'crashes', `${this.id}.json`); }

  _saveCrashes() {
    try {
      fs.mkdirSync(path.join(DATA_DIR, 'crashes'), { recursive: true });
      fs.writeFileSync(this._crashFile(), JSON.stringify(this.crashes));
    } catch { /* 记不下来也不能影响实例本身 */ }
  }

  /**
   * 启动前的端口占用检查,返回错误文案或 null。
   * 不查也能启动 —— java 自己会因为 BindException 退出 —— 但那条报错埋在
   * 一大段 Java 栈里,而且现在还会触发崩溃自动重启,反复撞同一个端口。
   * 代理(Velocity/Bungee)端口写在自己的配置里,读不到 server-port,跳过检查。
   */
  _portConflict() {
    const port = parseInt(this.getProp('server-port'), 10);
    if (!port) return null;

    // 先看同面板的其它实例:能报出是哪个实例,比"端口被占用"有用得多
    let peers = [];
    try { peers = [...require('./registry').instances.values()]; } catch {}
    const peer = peers.find((i) => i !== this && i.proc && parseInt(i.getProp('server-port'), 10) === port);
    if (peer) return `端口 ${port} 正被实例「${peer.name}」占用,请改 server-port 或先停掉它`;

    if (listeningPorts().has(port)) {
      return `端口 ${port} 已被本机其它进程占用 —— 若面板刚被强制重启(kill -9),可能是上次残留的服务端进程还在跑`;
    }
    return null;
  }

  /**
   * 记录"用户希望它是开着的",供面板重启后恢复用。
   * 只在 start / stop / kill 这些**有人表达意图**的地方翻转 —— 崩溃退出时保持不变,
   * 这样"崩了之后面板也挂了"的组合下,面板起来仍会把它拉回来。
   */
  _setWasRunning(v) {
    if (this.wasRunning === v) return;
    this.wasRunning = v;
    // 延迟 require:registry 依赖 instance,顶层引会成环
    try { require('./registry').saveRegistry(); } catch {}
  }

  /** 撤销待触发的自动重启并清零计数(手动启动、删除实例、面板退出时调用) */
  cancelAutoRestart() {
    clearTimeout(this._crashTimer);
    this._crashTimer = null;
    this._crashTimes = [];
    this.autoRestartBlocked = false;
  }

  _onServerLine(line) {
    // Paper format: [HH:MM:SS LEVEL]: message
    let time = ts(), level = 'INFO', message = line;
    const m = line.match(/^\[(\d{2}:\d{2}:\d{2})\s+(\w+)\]:?\s?(.*)$/);
    if (m) { time = m[1]; level = m[2].toUpperCase(); message = m[3]; }
    const entry = { time, level, message };
    this.logs.push(entry);
    if (this.logs.length > LOG_BUFFER_LINES) this.logs.shift();
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
    // restart() 也走这里,但它随后会再 start(),wasRunning 会被重新置回 true
    if (!this._restartAfterExit) this._setWasRunning(false);
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
    this._killedByUser = true;      // 强杀是用户点的,别当崩溃再拉起来
    this._setWasRunning(false);
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
    if (this.metricsHistory.length > METRICS_LIVE_POINTS) this.metricsHistory.shift();
    this._rollMinute(point);
    if (this.proc || this.metricsHistory.length < 3 || this.metricsHistory[this.metricsHistory.length - 2].ram !== 0) {
      bus.broadcast('metrics', { iid: this.id, ...point });
    }
  }
}

module.exports = { Instance, panel, sanitizeJvmArgs, listeningPorts };
