/* MCSP frontend — multi-instance SPA (vanilla JS) */

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

const VIEW_TITLES = {
  overview: ['总览', '宿主机与所有实例一览'],
  dashboard: ['仪表盘', ''],
  console: ['控制台', ''],
  players: ['玩家', ''],
  worlds: ['世界', ''],
  plugins: ['插件', ''],
  files: ['文件', ''],
  tasks: ['计划任务', ''],
  tunnel: ['内网穿透', ''],
  backups: ['备份', ''],
  settings: ['设置', ''],
  users: ['用户管理', '面板账户与权限'],
  system: ['系统设置', '注册开关与公告'],
  account: ['账号安全', '两步验证 · API Token · 登录设备'],
};

const TUNNEL_STATE_TEXT = {
  stopped: ['未启动', 'pill-gray'],
  starting: ['连接中…', 'pill-amber'],
  running: ['已建立', 'pill-green'],
};

const STATE_TEXT = {
  stopped: ['已停止', 'pill-gray'],
  installing: ['安装中…', 'pill-amber'],
  importing: ['导入中…', 'pill-amber'],
  starting: ['启动中…', 'pill-amber'],
  running: ['运行中', 'pill-green'],
  stopping: ['停止中…', 'pill-amber'],
};

const TYPE_LABELS = {
  paper: 'Paper', purpur: 'Purpur', folia: 'Folia', vanilla: 'Vanilla', fabric: 'Fabric',
  forge: 'Forge', neoforge: 'NeoForge', velocity: 'Velocity', waterfall: 'Waterfall', bungeecord: 'BungeeCord',
};
const typeLabel = (t) => TYPE_LABELS[t] || t || 'Paper';

let me = null;                    // current user
let uploadCfg = null;             // 服务端下发的分片大小/并发数(见 /auth/me)
let currentView = 'overview';
let currentIid = localStorage.getItem('mcsp_iid') || null;
let instMap = new Map();          // iid -> snapshot
let metricsHistory = [];
let metricsDay = [];                 // 分钟级聚合(近 24h),切到 day 档时按需拉取
let chartRange = 'live';
let cmdHistory = [];
let cmdHistoryIdx = -1;
let fmPath = '/';
let fmOpenFile = null;
/* 剪贴板只放内存:刷新后指向已删文件的陈旧剪贴板毫无意义。
   存 dir 是因为 fmSelected() 拿到的是名字不是路径,跨目录粘贴时需要源目录 */
let fmClip = null;               // { op:'cut'|'copy', iid, dir, names[] }
let fmLastIndex = null;          // Shift 范围选的锚点,每次换目录重置

/* ───────── helpers ───────── */

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  const data = await res.json();
  // 强制两步验证:后端把所有业务接口都拦了,光弹 toast 用户会以为面板坏了。
  // 直接把人送到「账号安全」页 —— 那是唯一还能用的地方,也正是要去的地方。
  if (res.status === 403 && data && data.code === '2fa_required') {
    force2FA(data.error);
    throw new Error('2fa_required');
  }
  return data;
}

/* 强制 2FA 引导。只弹一次横幅并切到账号页,别每个被拒的请求都弹一遍 */
let force2FAShown = false;
function force2FA(msg) {
  if (force2FAShown) return;
  force2FAShown = true;
  toast(msg || '管理员已要求启用两步验证', true);
  try { switchView('account'); } catch { /* 初始化早期还没准备好视图 */ }
}

const iapi = (path, opts) => api(`/instances/${currentIid}${path}`, opts);

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('err', isErr);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2600);
}

/**
 * 复制到剪贴板。navigator.clipboard 只在 https / localhost 下可用 ——
 * 面板经常是 http://内网IP:3000 这么开的,那里它直接抛异常。
 * 回落到临时 textarea + execCommand,老办法但到处都能用。
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

function fmtUptime(ms) {
  if (!ms) return '—';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function fmtAgo(t) {
  const d = Math.floor((Date.now() - t) / 864e5);
  if (d === 0) return '今天';
  if (d === 1) return '昨天';
  return `${d} 天前`;
}

function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1073741824).toFixed(2) + ' GB';
}

function avatarColor(name) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(145deg, hsl(${h},70%,55%), hsl(${(h + 40) % 360},65%,40%))`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* 引用 index.html 里的图标精灵表。名字见那份 <defs> */
function ico(name, cls = 'ico') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

/* ───────── navigation ───────── */

function switchView(view) {
  const instViews = !['overview', 'users', 'system', 'account'].includes(view);
  if (instViews && !currentIid) {
    toast('请先创建一个实例', true);
    view = 'overview';
  }
  currentView = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');
  let [title, sub] = VIEW_TITLES[view];
  // 普通用户看不到宿主机那张卡,副标题也别再提"宿主机"
  if (view === 'overview' && me && me.role !== 'admin') sub = '你的实例一览';
  $('#view-title').textContent = title;
  const inst = instMap.get(currentIid);
  $('#topbar-sub').textContent = sub || (inst ? `${inst.name} · ${typeLabel(inst.type)} ${inst.version} · 端口 ${inst.port}` : '');
  $('#inst-actions').hidden = ['overview', 'users', 'system', 'account'].includes(view);

  const loaders = {
    overview: loadOverview,
    dashboard: loadDashboard,
    console: () => {},
    players: loadPlayers,
    worlds: loadWorlds,
    plugins: loadPlugins,
    files: () => loadFiles(fmPath),
    tasks: loadTasks,
    tunnel: loadTunnel,
    backups: loadBackups,
    settings: () => { loadProperties(); loadRcon(); },
    users: loadUsers,
    system: loadSystem,
    account: loadAccount,
  };
  (loaders[view] || (() => {}))();
  // 容器这会儿才从 display:none 里出来、有了真实高度,贴底的滚动到这里才生效
  syncLogScroll();
}

$$('.nav-item').forEach((btn) => btn.addEventListener('click', () => switchView(btn.dataset.view)));

/* 侧栏分组折叠(状态存浏览器) */
$$('.nav-toggle').forEach((btn) => btn.addEventListener('click', () => {
  const g = btn.closest('.nav-group');
  g.classList.toggle('collapsed');
  const st = JSON.parse(localStorage.getItem('mcsp_nav_collapsed') || '{}');
  st[g.dataset.group] = g.classList.contains('collapsed');
  localStorage.setItem('mcsp_nav_collapsed', JSON.stringify(st));
}));
(() => {
  const st = JSON.parse(localStorage.getItem('mcsp_nav_collapsed') || '{}');
  $$('.nav-group').forEach((g) => { if (st[g.dataset.group]) g.classList.add('collapsed'); });
})();

/* ───────── instance selector ───────── */

function renderInstSelect() {
  const sel = $('#inst-select');
  // 下拉框永远显示第一项,所以 currentIid 失效时必须跟着归位 ——
  // 否则(比如刚建完第一个实例)选择器显示着实例,currentIid 却是 null,
  // 实例页面全被 switchView 弹回总览,而点回同一个选项不触发 change,只能刷新
  if (!instMap.has(currentIid)) {
    const first = instMap.values().next().value;
    currentIid = first ? first.id : null;
    if (currentIid) localStorage.setItem('mcsp_iid', currentIid);
    else localStorage.removeItem('mcsp_iid');
  }
  sel.innerHTML = [...instMap.values()]
    .map((i) => `<option value="${i.id}" ${i.id === currentIid ? 'selected' : ''}>${escapeHtml(i.name)}</option>`)
    .join('');
  const inst = instMap.get(currentIid);
  $('#inst-picker-icon').textContent = inst ? inst.icon : '⛰️';
}

$('#inst-select').addEventListener('change', async (e) => {
  currentIid = e.target.value;
  localStorage.setItem('mcsp_iid', currentIid);
  renderInstSelect();
  await refreshInstanceContext();
  if (currentView !== 'overview' && currentView !== 'users') switchView(currentView);
  else applyTopbar();
});

async function refreshInstanceContext() {
  metricsHistory = await iapi('/metrics/history');
  metricsDay = [];
  chartRange = 'live';
  $$('#chart-range button').forEach((b) => b.classList.toggle('active', b.dataset.range === 'live'));
  /* 回放整段历史日志时**不要**走 appendLog:那是给"一次一行"的实时流用的,
     每行都会写一次 scrollTop,于是每行强制一次同步布局 —— 300 行实测要 1.1 秒,
     整个界面在这期间是冻住的。拼好一次性塞进去只要 68ms。 */
  const logs = await iapi('/logs');
  logStick.clear();                    // 换了实例就是一份新日志,回到默认的贴底
  $('#console').innerHTML = logs.map(logLineHtml).join('');
  $('#dash-log').innerHTML = logs.slice(-80).map(logLineHtml).join('');   // 迷你日志只留 80 行
  syncLogScroll();
  fmPath = '/'; fmOpenFile = null; $('#fm-editor').hidden = true;
  fmClip = null; fmLastIndex = null; fmSyncClip();   // 剪贴板里的路径属于上一个实例,作废
  $('#log-q').value = ''; $('#log-level').value = '';
  logFilterOn = false; $('#log-clear').hidden = true; $('#log-count').textContent = '';
  applyTopbar();
  drawChart();
}

/* ───────── topbar / state ───────── */

function applyTopbar() {
  const inst = instMap.get(currentIid);
  if (!inst) return;
  const [txt, pillCls] = STATE_TEXT[inst.state] || STATE_TEXT.stopped;
  $('#top-state').className = `pill ${pillCls}`;
  $('#top-state').textContent = txt;
  $('#btn-start').disabled = inst.state !== 'stopped';
  $('#btn-stop').disabled = inst.state !== 'running' && inst.state !== 'starting';
  $('#btn-restart').disabled = inst.state !== 'running';
  $('#btn-kill').disabled = inst.state === 'stopped';
  if (currentView !== 'overview' && currentView !== 'users') {
    $('#topbar-sub').textContent = `${inst.name} · ${typeLabel(inst.type)} ${inst.version} · 端口 ${inst.port}`;
  }
  applyDashboardStats(inst);
}

function applyDashboardStats(inst) {
  if (inst.id !== currentIid) return;
  const [txt, pillCls] = STATE_TEXT[inst.state] || STATE_TEXT.stopped;
  const stateLabel = inst.state === 'installing' ? `安装中 ${inst.installProgress || 0}%` : txt;
  $('#stat-state').innerHTML = `<span class="pill ${pillCls}">${stateLabel}</span>`;
  $('#stat-uptime').textContent = '运行时长 ' + fmtUptime(inst.uptime);
  $('#stat-players').innerHTML = `${inst.playersOnline} <span class="dim small">/ ${inst.maxPlayers}</span>`;
  $('#stat-cpu').innerHTML = `${inst.metrics.cpu}<span class="dim small">%</span>`;
  $('#bar-cpu').style.width = Math.min(100, inst.metrics.cpu) + '%';
  /* RSS 超过 -Xmx 是**常态**,不是异常:-Xmx 只管堆,RSS 还含 Metaspace、Code Cache、
     线程栈、GC 自身结构和 Netty 的 direct buffer。原先这里 Math.min(100, …) 一夹,条子
     就永久钉在 100% —— "健康的堆外开销"和"真的要 OOM 了"长得一模一样,等于把唯一的
     证据藏起来了。照样满条,但换色并把超出量写出来,让人看得见超了多少。 */
  const overMB = inst.metrics.ram - inst.metrics.ramMax;
  const ramPct = inst.metrics.ramMax ? (inst.metrics.ram / inst.metrics.ramMax) * 100 : 0;
  $('#stat-ram').innerHTML = `${inst.metrics.ram} <span class="dim small">/ ${inst.metrics.ramMax} MB 堆`
    + (overMB > 0 ? ` · 堆外 +${overMB}` : '') + '</span>';
  $('#bar-ram').style.width = Math.min(100, ramPct) + '%';
  $('#bar-ram').classList.toggle('over', overMB > 0);
  $('#bar-ram').title = overMB > 0
    ? `RSS ${inst.metrics.ram} MB = 堆上限 ${inst.metrics.ramMax} MB + 堆外 ${overMB} MB(Metaspace / Code Cache / 线程栈 / Netty direct buffer)`
    : `RSS ${inst.metrics.ram} MB / 堆上限 ${inst.metrics.ramMax} MB`;
  renderTps(inst);
}

/**
 * TPS 格子。拿不到就如实显示"需要 RCON"——
 * 编一个 20.0 出来比不显示更糟:用户会以为服务器很健康。
 */
function renderTps(inst) {
  const el = $('#stat-tps');
  const bar = $('#bar-tps');
  if (!el) return;
  if (inst.tps === null || inst.tps === undefined) {
    el.innerHTML = inst.state === 'running'
      ? '<span class="dim small">需要 RCON</span>'
      : '—';
    bar.style.width = '0%';
    return;
  }
  // 20 是满速;低于 18 明显掉帧,低于 15 已经很难玩了
  const color = inst.tps >= 18 ? 'var(--green)' : (inst.tps >= 15 ? '#e5c07b' : '#ff9d96');
  el.innerHTML = `<span style="color:${color}">${inst.tps.toFixed(1)}</span>`
    + (inst.mspt != null ? ` <span class="dim small">${inst.mspt} ms/t</span>` : '');
  bar.style.width = Math.min(100, (inst.tps / 20) * 100) + '%';
  bar.style.background = color;
}

setInterval(() => {
  const inst = instMap.get(currentIid);
  if (inst && inst.state === 'running' && inst.startedAt) {
    inst.uptime = Date.now() - inst.startedAt;
    $('#stat-uptime').textContent = '运行时长 ' + fmtUptime(inst.uptime);
  }
}, 1000);

/* power buttons */
for (const [id, action, msg] of [
  ['#btn-start', 'start', '实例启动中…'],
  ['#btn-stop', 'stop', '正在停止实例'],
  ['#btn-restart', 'restart', '正在重启实例'],
  ['#btn-kill', 'kill', '已强制终止'],
]) {
  $(id).addEventListener('click', async () => {
    if (action === 'kill' && !confirm('强制终止不会保存世界数据,确定?')) return;
    const r = await iapi(`/server/${action}`, { method: 'POST' });
    r.ok ? toast(msg) : toast(r.error, true);
  });
}

/* ───────── overview ───────── */

/** Java 单元格:已装版本 / 下载进度 / 一键安装按钮(管理员) */
function javaCellHtml(host) {
  const j = host.java;
  const installing = j && j.majors.find((m) => m.installing);
  if (installing) return `<span class="dim small">下载 Java ${installing.major} … ${installing.progress}%</span>`;
  const have = j ? j.majors.filter((m) => m.installed).map((m) => m.major) : [];
  const missing = j ? j.majors.some((m) => !m.installed) : false;
  let text;
  if (host.javaVersion) {
    const m = host.javaVersion.match(/"([^"]+)"/);
    text = escapeHtml(m ? m[1] : host.javaVersion);
    if (have.length) text += ` <span class="dim small">托管 ${have.join('/')}</span>`;
  } else {
    text = '<span style="color:#ff9d96">未安装</span>';
  }
  if (missing && me && me.role === 'admin') {
    text += ` <button class="btn btn-blue small-btn" id="java-install-btn"
      style="margin-left:8px;padding:3px 10px;font-size:12px">${ico('download')}${have.length || host.javaVersion ? '补齐全部版本' : '一键安装'}</button>`;
  }
  return text;
}

async function loadOverview() {
  const [host, list] = await Promise.all([api('/host'), api('/instances')]);
  instMap = new Map(list.map((i) => [i.id, i]));
  renderInstSelect();

  // 宿主机一栏只有管理员能看:普通用户拿到的 /host 压根没有这些字段
  if (host.isAdmin) renderHostCard(host);

  renderDiskBreakdown(host);
  renderInstGrid();
}

function renderHostCard(host) {
  $('#host-name').textContent = `${host.hostname} · ${host.platform}`;
  /* 用 availMem(后端显式读 MemAvailable)而不是 freeMem。os.freemem() 的口径随 libuv
     版本变过 —— 老版本是 MemFree,会把可回收的 page cache 算作已用,而 MC 刷世界文件
     时 page cache 很大,这张卡会常年虚高。老面板的响应里没有 availMem,退回 freeMem。 */
  const avail = host.availMem !== undefined ? host.availMem : host.freeMem;
  const memPct = Math.round(((host.totalMem - avail) / host.totalMem) * 100);
  /* 已承诺 = Σ(堆 + 堆外余量),也就是配额拦人用的那个数。跟真实用量并排放,是因为
     两者不是一回事:配额还有余、机器已经满了,这种局面得在这里看得出来 */
  const commit = host.committedMem || 0;
  const commitPct = Math.round((commit / host.totalMem) * 100);
  $('#host-grid').innerHTML = [
    ['CPU', `${escapeHtml(host.cpuModel.split(' ').slice(0, 3).join(' '))} <span class="dim small">× ${host.cores}</span>`],
    ['负载', `${host.loadavg.join(' / ')}`],
    ['内存', `${memPct}% <span class="dim small">${Math.round((host.totalMem - avail) / 1024)} / ${Math.round(host.totalMem / 1024)} GB 实际用量</span>`],
    ['已承诺', `<span class="${commitPct >= 100 ? 'disk-warn' : ''}">${commitPct}%</span> <span class="dim small">${(commit / 1024).toFixed(1)} GB · 全部实例 -Xmx + 堆外余量</span>`],
    ['磁盘', host.disk
      ? `<span class="${host.disk.usedPct >= 90 ? 'disk-warn' : ''}">${host.disk.usedPct}%</span> <span class="dim small">${(host.disk.usedMB / 1024).toFixed(1)} / ${(host.disk.totalMB / 1024).toFixed(1)} GB</span>`
      : '<span class="dim small">不可用</span>'],
    ['面板运行', fmtUptime(host.panelUptime)],
    ['Java', `<span id="java-cell">${javaCellHtml(host)}</span>`],
    ['Node', host.nodeVersion],
    ['实例', `${host.runningCount} <span class="dim small">运行 / ${host.instanceCount} 总数</span>`],
    ['架构', `${escapeHtml(host.platform.split(' ')[0])} ${host.arch}`],
  ].map(([l, v]) => `<div class="host-item"><div class="h-label">${l}</div><div class="h-value">${v}</div></div>`).join('');
}

/* 各实例吃了多少磁盘 —— 只有存在实例时才显示,空面板不摆一张空卡片 */
function renderDiskBreakdown(host) {
  const rows = (host.instanceDisk || []).filter((d) => d.totalMB > 0);
  const box = $('#disk-breakdown');
  box.hidden = !rows.length;
  if (!rows.length) return;
  const max = rows[0].totalMB || 1;
  $('#disk-rows').innerHTML = rows.map((d) => `
    <div class="disk-row">
      <div class="d-name">${d.icon || '🌳'} ${escapeHtml(d.name)}</div>
      <div class="d-bar"><i style="width:${Math.max(2, Math.round((d.totalMB / max) * 100))}%"></i></div>
      <div class="d-size">${fmtSize(d.totalMB * 1048576)}</div>
      <div class="d-detail dim small">实例 ${fmtSize(d.instMB * 1048576)} · 备份 ${fmtSize(d.backupMB * 1048576)}</div>
    </div>`).join('');
}

function renderInstGrid() {
  if (!instMap.size) {
    $('#inst-grid').innerHTML = `<div class="card glass" style="grid-column:1/-1">
      <div class="empty">还没有实例。点击右上角「＋ 新建实例」,支持 Paper / Purpur / Folia / Vanilla / Fabric / Forge / NeoForge 及 Velocity 等代理,均从官方源自动下载安装。</div>
    </div>`;
    return;
  }
  $('#inst-grid').innerHTML = [...instMap.values()].map((i) => {
    const [txt, pillCls] = STATE_TEXT[i.state] || STATE_TEXT.stopped;
    return `
      <div class="card glass inst-card" data-iid="${i.id}" data-state="${i.state}">
        <div class="inst-actions">
          <button class="icon-btn inst-clone" data-clone="${i.id}" title="克隆实例" aria-label="克隆实例 ${escapeHtml(i.name)}">${ico('archive')}</button>
          <button class="icon-btn danger inst-del" data-del="${i.id}" title="删除实例" aria-label="删除实例 ${escapeHtml(i.name)}">${ico('trash')}</button>
        </div>
        <div class="inst-head">
          <div class="inst-ico">${i.icon}</div>
          <div>
            <div class="inst-name">${escapeHtml(i.name)}</div>
            <div class="inst-ver">${typeLabel(i.type)} ${i.version} · :${i.port}${me && me.role === 'admin' && i.owner && i.owner !== me.username ? ` · ☺ ${escapeHtml(i.owner)}` : ''}</div>
          </div>
        </div>
        <div class="inst-stats">
          <span>玩家 <b>${i.playersOnline}/${i.maxPlayers}</b></span>
          <span>CPU <b>${i.metrics.cpu}%</b></span>
          <span>内存 <b>${(i.metrics.ram / 1024).toFixed(1)}G</b></span>
        </div>
        ${i.tunnel && i.tunnel.state === 'running' && i.tunnel.addr
          ? `<div class="inst-stats" style="margin-top:-8px"><span>${ico('tunnel')} <b>${escapeHtml(i.tunnel.addr)}</b></span></div>` : ''}
        <div class="inst-foot">
          <span class="pill ${pillCls}">${i.state === 'installing' ? `安装中 ${i.installProgress || 0}%` : txt}</span>
          <div class="spacer"></div>
          ${i.state === 'stopped'
            ? `<button class="btn btn-green small-btn" data-power="start" data-iid="${i.id}">${ico('play')}启动</button>`
            : (i.state === 'installing' || i.state === 'importing') ? ''
            : `<button class="btn btn-red small-btn" data-power="stop" data-iid="${i.id}">${ico('stop')}停止</button>`}
          <button class="btn btn-ghost small-btn" data-open="${i.id}">管理</button>
        </div>
      </div>`;
  }).join('');
}

/* Java 一键安装:下载 Temurin 21/17/8 到面板 bin/java/,进度经 SSE 刷新 */
$('#host-grid').addEventListener('click', async (e) => {
  const btn = e.target.closest('#java-install-btn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '安装中…';
  toast('开始下载 Java 运行时(Temurin,官方源)…');
  const r = await api('/java/install', { method: 'POST' });
  r.ok ? toast('Java 运行时安装完成') : toast(r.error, true);
  if (currentView === 'overview') loadOverview();
});

$('#inst-grid').addEventListener('click', async (e) => {
  const clone = e.target.closest('[data-clone]');
  if (clone) {
    e.stopPropagation();
    const src = instMap.get(clone.dataset.clone);
    if (src && src.state !== 'stopped') return toast('请先停止源实例再克隆', true);
    const name = prompt('克隆为新实例,名称:', src ? src.name + ' 副本' : '');
    if (!name || !name.trim()) return;
    clone.disabled = true;
    toast('正在复制世界与配置,大存档可能要等一会…');
    const r = await api(`/instances/${clone.dataset.clone}/clone`, { method: 'POST', body: { name: name.trim() } });
    clone.disabled = false;
    if (r.ok) {
      toast(r.port ? `已克隆为「${r.instance.name}」,端口 ${r.port}` : `已克隆为「${r.instance.name}」,请手动设置端口`);
      loadOverview();
    } else toast(r.error, true);
    return;
  }
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    if (!confirm('删除实例将移除其全部配置与备份记录,确定?')) return;
    const r = await api(`/instances/${del.dataset.del}`, { method: 'DELETE' });
    if (r.ok) { toast('实例已删除'); loadOverview(); } else toast(r.error, true);
    return;
  }
  const power = e.target.closest('[data-power]');
  if (power) {
    e.stopPropagation();
    const r = await api(`/instances/${power.dataset.iid}/server/${power.dataset.power}`, { method: 'POST' });
    r.ok ? toast(power.dataset.power === 'start' ? '实例启动中…' : '正在停止实例') : toast(r.error, true);
    return;
  }
  const open = e.target.closest('[data-open]') || e.target.closest('.inst-card');
  if (open) {
    const iid = open.dataset.open || open.dataset.iid;
    currentIid = iid;
    localStorage.setItem('mcsp_iid', iid);
    renderInstSelect();
    await refreshInstanceContext();
    switchView('dashboard');
  }
});

/* create instance modal */
let serverTypes = null;                 // /api/servertypes 结果缓存
const typeVersionCache = new Map();     // type -> versions[]

/** 把某个类型的版本列表填进指定的 <select>;新建实例与重装两处共用 */
async function fillVersions(typeSel, verSel, selected) {
  const t = $(typeSel).value;
  let list = typeVersionCache.get(t);
  if (!list) {
    $(verSel).innerHTML = '<option value="">加载版本列表…</option>';
    const r = await api(`/servertypes/${t}/versions`);
    if (!r.ok || !r.versions.length) {
      $(verSel).innerHTML = `<option value="">版本加载失败${r.error ? ':' + r.error : ''}</option>`;
      return;
    }
    list = r.versions;
    typeVersionCache.set(t, list);
  }
  if ($(typeSel).value !== t) return;   // 等待期间用户又切了类型
  $(verSel).innerHTML = list.map((v, i) =>
    `<option value="${v}" ${v === selected || (!selected && i === 0) ? 'selected' : ''}>${v}</option>`).join('');
}

/** 确保 serverTypes 已加载,并把类型填进指定 <select> */
async function fillTypes(typeSel, selected) {
  if (!serverTypes) {
    const r = await api('/servertypes');
    if (!r.ok) { toast('服务端类型加载失败', true); return false; }
    serverTypes = r.types;
  }
  $(typeSel).innerHTML = serverTypes.map((t) =>
    `<option value="${t.key}" ${t.key === selected ? 'selected' : ''}>${t.label}</option>`).join('');
  return true;
}

async function loadTypeVersions() {
  const t = $('#ni-type').value;
  const info = (serverTypes || []).find((x) => x.key === t);
  // 类型提示 + 代理无需 EULA
  $('#ni-type-hint').hidden = !(info && info.note);
  $('#ni-type-hint').textContent = info && info.note ? `ⓘ ${info.note}` : '';
  $('#ni-eula-row').style.display = info && info.category === 'proxy' ? 'none' : '';
  await fillVersions('#ni-type', '#ni-version');
}

/* 批量启停:只对状态确实需要变的实例发指令,并且逐个发 ——
   一口气 spawn 十个 JVM 会把磁盘顶满,谁都起不来(和面板重启恢复同一个道理) */
async function bulkPower(action) {
  const want = action === 'start' ? 'stopped' : 'running';
  const targets = [...instMap.values()].filter((i) => i.state === want);
  if (!targets.length) return toast(action === 'start' ? '没有已停止的实例' : '没有正在运行的实例');
  if (!confirm(`${action === 'start' ? '启动' : '停止'} ${targets.length} 个实例?\n\n` + targets.map((i) => '· ' + i.name).join('\n'))) return;
  let okCount = 0;
  for (const inst of targets) {
    const r = await api(`/instances/${inst.id}/server/${action}`, { method: 'POST' });
    if (r.ok) okCount++;
    else toast(`${inst.name}: ${r.error}`, true);
    if (action === 'start') await new Promise((r2) => setTimeout(r2, 3000));   // 错峰
  }
  toast(`${okCount}/${targets.length} 个实例已${action === 'start' ? '启动' : '停止'}`);
}
$('#bulk-start').addEventListener('click', () => bulkPower('start'));
$('#bulk-stop').addEventListener('click', () => bulkPower('stop'));

$('#inst-create').addEventListener('click', async () => {
  $('#inst-modal').hidden = false;
  $('#ni-name').focus();
  if (!serverTypes) {
    if (await fillTypes('#ni-type')) loadTypeVersions();
  }
});
$('#ni-type').addEventListener('change', loadTypeVersions);
$('#ni-cancel').addEventListener('click', () => { $('#inst-modal').hidden = true; });
$('#ni-ok').addEventListener('click', async () => {
  const tinfo = (serverTypes || []).find((x) => x.key === $('#ni-type').value);
  const isProxy = tinfo && tinfo.category === 'proxy';
  if (!isProxy && !$('#ni-eula').checked) return toast('需要先同意 Minecraft EULA', true);
  if (!$('#ni-version').value) return toast('版本列表尚未加载', true);
  const r = await api('/instances', {
    method: 'POST',
    body: {
      name: $('#ni-name').value,
      type: $('#ni-type').value,
      version: $('#ni-version').value,
      port: $('#ni-port').value,
      gamemode: $('#ni-gamemode').value,
      icon: $('#ni-icon').value,
      xmx: $('#ni-xmx').value,
      eula: true,
    },
  });
  if (r.ok) {
    $('#inst-modal').hidden = true;
    $('#ni-name').value = ''; $('#ni-port').value = ''; $('#ni-eula').checked = false;
    toast('实例已创建,正在下载服务端…');
    loadOverview();
  } else toast(r.error, true);
});

/* ───────── 导入已有服务器 ─────────
   三步:建空壳实例 → 传压缩包(复用带进度的上传) → finalize 解压并探测。
   拆成三步是为了能白嫖现成的上传进度条 —— 存档动辄几个 G,没进度条没法用。 */

$('#inst-import').addEventListener('click', () => {
  $('#imp-progress').hidden = true;
  $('#imp-progress').innerHTML = '';
  $('#imp-modal').hidden = false;
  $('#imp-name').focus();
});
$('#imp-cancel').addEventListener('click', () => { $('#imp-modal').hidden = true; });

$('#imp-ok').addEventListener('click', async () => {
  const name = $('#imp-name').value.trim();
  const file = $('#imp-file').files[0];
  if (!name) return toast('请填写实例名称', true);
  if (!file) return toast('请选择服务器压缩包', true);

  const btn = $('#imp-ok');
  btn.disabled = true;
  const bar = $('#imp-progress');
  bar.hidden = false;
  const setStep = (t, pct) => {
    bar.innerHTML = `<div class="up-row"><span class="up-name">${escapeHtml(t)}</span>
      <span class="up-bar"><i style="width:${pct}%"></i></span></div>`;
  };

  try {
    setStep('正在创建实例…', 2);
    const created = await api('/instances/import', {
      method: 'POST',
      body: { name, icon: $('#imp-icon').value, xmx: $('#imp-xmx').value },
    });
    if (!created.ok) throw new Error(created.error);
    const iid = created.instance.id;

    const up = await uploadOne(file, '/', true, (p) => setStep(`上传 ${file.name}`, Math.round(p * 92)), iid);
    if (!up.ok) throw new Error(up.error);

    // 解压大包要几十秒,进度拿不到,至少别让进度条卡在 92% 装死
    setStep('正在解压并识别服务端…', 96);
    const fin = await api(`/instances/${iid}/import/finalize`, {
      method: 'POST',
      body: { archive: '/' + file.name, eula: $('#imp-eula').checked },
    });
    if (!fin.ok) throw new Error(fin.error);

    setStep('完成', 100);
    const d = fin.detected || {};
    toast(d.type
      ? `已导入:${typeLabel(d.type)} ${d.version || '(版本未知)'}`
      : '已导入,但未能识别服务端类型,请到设置页确认');
    if (d.notes && d.notes.length) toast(d.notes[0], true);

    $('#imp-modal').hidden = true;
    $('#imp-name').value = ''; $('#imp-file').value = ''; $('#imp-eula').checked = false;
    currentIid = iid;                       // 导完直接切过去,省得用户再找一遍
    localStorage.setItem('mcsp_iid', iid);
    await loadOverview();
    await refreshInstanceContext();
    switchView('dashboard');
  } catch (e) {
    toast(e.message || '导入失败', true);
    bar.hidden = true;
  } finally {
    btn.disabled = false;
  }
});

/* ───────── dashboard & chart ───────── */

async function loadDashboard() {
  const inst = await iapi('/status');
  instMap.set(inst.id, inst);
  applyTopbar();
  metricsHistory = await iapi('/metrics/history');
  drawChart();
}

const canvas = $('#chart');
const ctx = canvas.getContext('2d');

function drawChart() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = 190;
  if (!w) return;
  canvas.width = w * dpr; canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // day 档画分钟级聚合(用峰值,均值会把尖峰抹平,而排查 OOM 就是要看尖峰)
  const data = chartRange === 'day'
    ? metricsDay.map((p) => ({ t: p.t, cpu: p.cpuPeak, ram: p.ramPeak }))
    : metricsHistory.slice(-90);
  if (data.length < 2) {
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.font = '13px system-ui, sans-serif';
    ctx.fillText(chartRange === 'day' ? '还没有攒够一分钟的数据' : '暂无数据', 12, h / 2);
    return;
  }

  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  for (let i = 1; i <= 3; i++) {
    const y = (h / 4) * i;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }

  const step = w / (data.length - 1);
  const line = (get, max, color, fill) => {
    // smooth curve through midpoints
    const pts = data.map((p, i) => [i * step, h - (get(p) / max) * (h - 14) - 6]);
    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i][0] + pts[i + 1][0]) / 2;
        const my = (pts[i][1] + pts[i + 1][1]) / 2;
        ctx.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
      }
      ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
    };
    if (fill) {
      trace();
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, fill); g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.fill();
    }
    trace();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.shadowColor = color;
    ctx.shadowBlur = document.documentElement.dataset.style === 'pixel' ? 0 : 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
  };

  const inst = instMap.get(currentIid);
  const ramMax = (inst && inst.metrics.ramMax) || 2048;
  const acc = getComputedStyle(document.documentElement).getPropertyValue('--acc-rgb').trim() || '10, 132, 255';
  line((p) => p.cpu, Math.max(100, ...data.map((p) => p.cpu)), `rgb(${acc})`, `rgba(${acc}, 0.22)`);
  line((p) => p.ram, ramMax, '#30d158', null);
}

window.addEventListener('resize', drawChart);

/* ───────── console & logs ───────── */

function logLineHtml(entry) {
  return `<div><span class="time">${entry.time}</span><span class="lv-${entry.level}">${entry.level}</span>${escapeHtml(entry.message)}</div>`;
}

/* 日志筛选:开着筛选时新日志不再实时追加(否则筛选结果会被无关行冲散),
   顶部显示命中数并提供「清除筛选」回到实时流 */
let logFilterOn = false;

async function applyLogFilter() {
  const q = $('#log-q').value.trim();
  const level = $('#log-level').value;
  logFilterOn = !!(q || level);
  $('#log-clear').hidden = !logFilterOn;

  if (!logFilterOn) {
    // 只重绘控制台;走 appendLog 会连仪表盘的迷你日志一起再追加一遍
    $('#log-count').textContent = '';
    const logs = await iapi('/logs');
    $('#console').innerHTML = logs.map(logLineHtml).join('');
    logStick.set('#console', true);        // 重绘完回到最新那几行
    syncLogScroll();
    return;
  }
  const qs = new URLSearchParams({ limit: '1000' });
  if (q) qs.set('q', q);
  if (level) qs.set('level', level);
  const d = await iapi(`/logs?${qs}`);
  if (!d.ok) return toast(d.error || '搜索失败', true);
  $('#log-count').textContent = `命中 ${d.total} 行 / 缓冲 ${d.buffered} 行`
    + (d.total > d.lines.length ? `(只显示最近 ${d.lines.length} 行)` : '');
  $('#console').innerHTML = d.lines.map(logLineHtml).join('') || '<div class="dim">没有匹配的日志</div>';
  logStick.set('#console', true);          // 搜索结果同理:先看见最近命中的
  syncLogScroll();
}

const debouncedLogFilter = (() => {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(applyLogFilter, 250); };
})();

$('#log-q').addEventListener('input', debouncedLogFilter);
$('#log-level').addEventListener('change', applyLogFilter);
$('#log-clear').addEventListener('click', () => {
  $('#log-q').value = '';
  $('#log-level').value = '';
  applyLogFilter();
});
$('#log-download').addEventListener('click', () => {
  const qs = new URLSearchParams();
  if ($('#log-q').value.trim()) qs.set('q', $('#log-q').value.trim());
  if ($('#log-level').value) qs.set('level', $('#log-level').value);
  const a = document.createElement('a');
  a.href = `/api/instances/${currentIid}/logs/download${qs.toString() ? '?' + qs : ''}`;
  a.click();
  toast(logFilterOn ? '正在下载(仅当前筛选结果)' : '正在下载完整控制台日志');
});

/* ── 日志容器的"贴底"状态 ──
 *
 * 默认贴底:日志这东西最有用的永远是最新几行,进来就该看见它们。
 *
 * 状态记在这里而不是每次去量 scrollHeight —— 因为 .view 没激活时是
 * display:none,容器量出来 scrollHeight/clientHeight 全是 0,"在底部"恒为真、
 * 可 scrollTop 又写不进去(元素没有可滚动区域)。等切回该视图,它就停在最顶上,
 * 也就是最没用的位置。这正是之前控制台和实时动态进去都得手动往下拖的原因。
 *
 * 用户自己往上翻(看历史)时置为 false,翻回底部再置回 true —— 实时日志刷屏
 * 时不会把人正在读的位置拽走。
 */
const LOG_PANES = ['#console', '#dash-log'];
const logStick = new Map();
const stickyBottom = (sel) => logStick.get(sel) !== false;      // 没记录过 = 默认贴底

/** 视图刚显示出来时调用:这时候容器才拿到真实高度,该贴底的现在才滚得动 */
function syncLogScroll() {
  for (const sel of LOG_PANES) {
    const el = $(sel);
    if (el && el.clientHeight && stickyBottom(sel)) el.scrollTop = el.scrollHeight;
  }
}

for (const sel of LOG_PANES) {
  $(sel).addEventListener('scroll', () => {
    const el = $(sel);
    if (!el.clientHeight) return;      // 隐藏状态下的 scroll 事件量不准,不作数
    logStick.set(sel, el.scrollHeight - el.scrollTop - el.clientHeight < 60);
  });
}

function appendLog(entry) {
  // 筛选生效时别把实时日志混进结果里 —— 但仪表盘的迷你日志不受筛选影响,照常追加
  const targets = logFilterOn ? [['#dash-log', 80]] : [['#console', 400], ['#dash-log', 80]];
  for (const [sel, cap] of targets) {
    const el = $(sel);
    el.insertAdjacentHTML('beforeend', logLineHtml(entry));
    while (el.children.length > cap) el.firstChild.remove();
    if (stickyBottom(sel)) el.scrollTop = el.scrollHeight;
  }
}

/* Tab 补全:MC 常用命令 + 当前在线玩家名。和已有的 ↑↓ 历史凑成一个像样的终端 */
const MC_COMMANDS = [
  'list', 'say', 'tell', 'me', 'kick', 'ban', 'ban-ip', 'pardon', 'pardon-ip', 'banlist',
  'op', 'deop', 'whitelist add', 'whitelist remove', 'whitelist list', 'whitelist on', 'whitelist off', 'whitelist reload',
  'gamemode survival', 'gamemode creative', 'gamemode adventure', 'gamemode spectator',
  'difficulty peaceful', 'difficulty easy', 'difficulty normal', 'difficulty hard',
  'time set day', 'time set night', 'time set noon', 'time set midnight', 'time add',
  'weather clear', 'weather rain', 'weather thunder',
  'gamerule keepInventory true', 'gamerule doDaylightCycle', 'gamerule doMobSpawning', 'gamerule randomTickSpeed',
  'give', 'tp', 'teleport', 'kill', 'clear', 'effect give', 'effect clear', 'enchant', 'xp',
  'save-all', 'save-on', 'save-off', 'stop', 'reload confirm', 'seed', 'difficulty',
  'setworldspawn', 'spawnpoint', 'defaultgamemode', 'setblock', 'fill', 'locate structure',
  'tps', 'plugins', 'version', 'timings on', 'timings off', 'mspt',
];

function completionPool() {
  const names = $$('#player-list .player-name').map((el) => el.textContent.trim().split(' ')[0]).filter(Boolean);
  return MC_COMMANDS.concat(names);
}

/** 最长公共前缀 —— 和 shell 的 Tab 行为一致:先补到分歧点,再按一次列出候选 */
function commonPrefix(list) {
  if (!list.length) return '';
  let p = list[0];
  for (const s of list) {
    let i = 0;
    while (i < p.length && i < s.length && p[i].toLowerCase() === s[i].toLowerCase()) i++;
    p = p.slice(0, i);
  }
  return p;
}

function handleTabComplete(input) {
  const val = input.value;
  if (!val.trim()) return;
  const matches = completionPool().filter((c) => c.toLowerCase().startsWith(val.toLowerCase()));
  if (!matches.length) return;
  if (matches.length === 1) { input.value = matches[0] + ' '; return; }
  const pre = commonPrefix(matches);
  if (pre.length > val.length) input.value = pre;
  else appendLog({ time: '', level: 'INFO', message: `[补全] ${matches.slice(0, 24).join('  ')}${matches.length > 24 ? ' …' : ''}` });
}

async function sendCommand() {
  const input = $('#cmd-input');
  const command = input.value.trim();
  if (!command) return;
  cmdHistory.push(command);
  cmdHistoryIdx = cmdHistory.length;
  input.value = '';
  const r = await iapi('/command', { method: 'POST', body: { command } });
  if (!r.ok) toast(r.error, true);
}

$('#cmd-send').addEventListener('click', sendCommand);
$('#cmd-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendCommand();
  else if (e.key === 'ArrowUp') {
    if (cmdHistoryIdx > 0) { cmdHistoryIdx--; e.target.value = cmdHistory[cmdHistoryIdx]; e.preventDefault(); }
  } else if (e.key === 'ArrowDown') {
    if (cmdHistoryIdx < cmdHistory.length - 1) { cmdHistoryIdx++; e.target.value = cmdHistory[cmdHistoryIdx]; }
    else { cmdHistoryIdx = cmdHistory.length; e.target.value = ''; }
  } else if (e.key === 'Tab') {
    e.preventDefault();                 // 否则焦点会跳到「发送」按钮上
    handleTabComplete(e.target);
  }
});
$$('.chip[data-cmd]').forEach((c) =>
  c.addEventListener('click', async () => {
    const r = await iapi('/command', { method: 'POST', body: { command: c.dataset.cmd } });
    if (!r.ok) toast(r.error, true);
  })
);

/* ───────── players ───────── */

async function loadPlayers() {
  loadPlaytime();
  const d = await iapi('/players');
  $('#pl-count').textContent = d.online.length;

  const list = $('#player-list');
  if (!d.online.length) {
    list.innerHTML = '<div class="empty">当前没有在线玩家。启动实例后玩家会陆续加入。</div>';
  } else {
    list.innerHTML = d.online.map((p) => `
      <div class="player-item">
        ${p.uuid
          ? `<img class="avatar" src="https://mc-heads.net/avatar/${escapeHtml(p.uuid)}/32" alt=""
               onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'avatar',textContent:'${escapeHtml(p.name[0].toUpperCase())}',style:'background:${avatarColor(p.name)}'}))">`
          : `<div class="avatar" style="background:${avatarColor(p.name)}">${escapeHtml(p.name[0].toUpperCase())}</div>`}
        <div>
          <div class="player-name">${escapeHtml(p.name)} ${p.op ? '<span title="OP">👑</span>' : ''}</div>
          <div class="player-meta">${p.op ? 'OP · ' : ''}在线${p.uuid ? ` · <code class="dim">${escapeHtml(p.uuid.slice(0, 8))}…</code>` : ''}</div>
        </div>
        <div class="spacer"></div>
        <button class="icon-btn ${p.op ? 'gold' : ''}" data-act="${p.op ? 'deop' : 'op'}" data-name="${p.name}">${p.op ? '取消OP' : '设为OP'}</button>
        <button class="icon-btn danger" data-act="kick" data-name="${p.name}">踢出</button>
        <button class="icon-btn danger" data-act="ban" data-name="${p.name}">封禁</button>
      </div>`).join('');
  }

  $('#ban-list').innerHTML = d.banned.length
    ? d.banned.map((b) => {
        const when = b.created ? String(b.created).slice(0, 10) : '';
        const tip = [b.reason && `理由: ${b.reason}`, when && `时间: ${when}`, b.source && `操作者: ${b.source}`]
          .filter(Boolean).join('\n');
        return `<span class="tag" title="${escapeHtml(tip)}">${escapeHtml(b.name)}${b.reason
          ? `<span class="dim small">· ${escapeHtml(b.reason.slice(0, 20))}</span>` : ''}<button data-act="pardon" data-name="${escapeHtml(b.name)}" title="解封">×</button></span>`;
      }).join('')
    : '<div class="empty">暂无封禁玩家</div>';

  $('#wl-list').innerHTML = d.whitelist.length
    ? d.whitelist.map((n) => `<span class="tag">${escapeHtml(n)}<button data-act="whitelist-remove" data-name="${n}" title="移除">×</button></span>`).join('')
    : '<div class="empty">白名单为空</div>';
}

$('#view-players').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const body = {};
  // 封禁/踢出可以带理由 —— 玩家在客户端上看到的就是这句话
  if (act === 'ban' || act === 'kick') {
    const reason = prompt(`${act === 'ban' ? '封禁' : '踢出'} ${btn.dataset.name} 的理由(玩家会看到):`, '');
    if (reason === null) return;
    body.reason = reason.trim();
  }
  const r = await iapi(`/players/${encodeURIComponent(btn.dataset.name)}/${act}`, { method: 'POST', body });
  r.ok ? loadPlayers() : toast(r.error, true);
});

$('#wl-add').addEventListener('click', async () => {
  const name = $('#wl-input').value.trim();
  if (!name) return;
  $('#wl-input').value = '';
  await iapi(`/players/${encodeURIComponent(name)}/whitelist-add`, { method: 'POST' });
  loadPlayers();
});

/* ───────── worlds ───────── */

const WORLD_META = {
  normal: ['🌳', '主世界'],
  nether: ['🔥', '下界'],
  the_end: ['🐉', '末地'],
};

$('#nw-go').addEventListener('click', async () => {
  const name = $('#nw-name').value.trim();
  if (!name) return toast('填个世界名', true);
  if (!confirm(`新建世界「${name}」并切换过去?\n\n当前世界的存档不会被删,可以随时切回来。\n实例需要重新启动,由服务端生成地形。`)) return;
  const r = await iapi('/worlds/create', { method: 'POST', body: { name, seed: $('#nw-seed').value.trim() } });
  if (!r.ok) return toast(r.error, true);
  $('#nw-name').value = ''; $('#nw-seed').value = '';
  toast('已切换,启动实例后生成');
  loadWorlds();
});

$('#world-grid').addEventListener('click', async (e) => {
  const use = e.target.closest('[data-wuse]');
  if (use) {
    if (!confirm(`把「${use.dataset.wuse}」设为当前世界?重启实例后生效。`)) return;
    const r = await iapi('/worlds/activate', { method: 'POST', body: { name: use.dataset.wuse } });
    r.ok ? (toast('已切换,重启实例后生效'), loadWorlds()) : toast(r.error, true);
    return;
  }
  const del = e.target.closest('[data-wdel]');
  if (del) {
    if (!confirm(`删除世界「${del.dataset.wdel}」?\n\n存档会被真的删掉且无法撤销。建议先在「备份」页做一份。`)) return;
    const r = await iapi(`/worlds/${encodeURIComponent(del.dataset.wdel)}`, { method: 'DELETE' });
    r.ok ? (toast('已删除'), loadWorlds()) : toast(r.error, true);
  }
});

async function loadWorlds() {
  const worlds = await iapi('/worlds');
  if (!worlds.length) {
    $('#world-grid').innerHTML = '<div class="card glass"><div class="empty">还没有世界数据。首次启动实例后,服务端会生成 world / world_nether / world_the_end。</div></div>';
    return;
  }
  $('#world-grid').innerHTML = worlds.map((w) => {
    const [emoji, label] = WORLD_META[w.env] || ['🌍', w.env];
    const overworld = w.env === 'normal';
    return `
      <div class="card glass world-card">
        <div class="world-banner ${w.env}"></div>
        <div class="world-emoji" style="margin-top:-52px;position:relative">${emoji}</div>
        <div class="world-name" style="margin-top:10px">${escapeHtml(w.name)} <span class="dim small">${label}</span></div>
        <div class="world-info">
          磁盘占用 <b>${w.sizeMB >= 1024 ? (w.sizeMB / 1024).toFixed(2) + ' GB' : w.sizeMB + ' MB'}</b>
        </div>
        <div class="world-actions">
          ${w.active ? '<span class="task-badge">当前世界</span>'
            : w.linked ? '<span class="task-badge off">属于当前世界</span>'
            : `<button class="chip" data-wuse="${escapeHtml(w.name)}">设为当前</button>
               <button class="chip danger" data-wdel="${escapeHtml(w.name)}">删除</button>`}
        </div>
        ${overworld && w.active ? `
        <div class="world-actions">
          <button class="chip" data-world="${w.name}" data-wact="time" data-val="day">☀️ 白天</button>
          <button class="chip" data-world="${w.name}" data-wact="time" data-val="night">🌙 夜晚</button>
          <button class="chip" data-world="${w.name}" data-wact="weather" data-val="clear">晴天</button>
          <button class="chip" data-world="${w.name}" data-wact="weather" data-val="rain">下雨</button>
          <button class="chip" data-world="${w.name}" data-wact="weather" data-val="thunder">雷暴</button>
        </div>` : ''}
      </div>`;
  }).join('');
}

$('#view-worlds').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-wact]');
  if (!btn) return;
  const r = await iapi(`/worlds/${btn.dataset.world}/${btn.dataset.wact}`, { method: 'POST', body: { value: btn.dataset.val } });
  r.ok ? (toast('已执行'), loadWorlds()) : toast(r.error, true);
});

/* ───────── plugins ───────── */

async function loadPlugins() {
  const d = await iapi('/plugins');
  const items = d.items || [];
  const noun = d.noun || '插件';
  // Paper 系是 plugins/,Fabric/Forge 是 mods/,Vanilla 两者都不支持 —— 标题跟着实例类型走,
  // 免得 Forge 用户在写着「插件」的页面上找模组
  $('#view-title').textContent = noun;
  const navBtn = $('.nav-item[data-view="plugins"]');
  if (navBtn) navBtn.lastChild.textContent = noun;   // 只换文字,别把图标一起冲掉

  $('#pl-search-card').hidden = !d.dir;
  if (!d.dir) {
    $('#plugin-list').innerHTML = `<div class="card glass"><div class="empty">
      原版(Vanilla)服务端不支持插件或模组。想装插件请改用 Paper / Purpur / Folia,
      想装模组请用 Fabric / Forge / NeoForge。</div></div>`;
    return;
  }
  if (!items.length) {
    $('#plugin-list').innerHTML = `<div class="card glass"><div class="empty">
      <code>${d.dir}/</code> 目录为空。把${noun} .jar 放进实例的 <code>${d.dir}/</code>
      目录(可在「文件」页上传,压缩包可直接解压),重启实例即可加载。</div></div>`;
    return;
  }
  $('#plugin-list').innerHTML = items.map((p) => `
    <div class="card glass plugin-item">
      <div class="plugin-icon">${escapeHtml(p.name[0] || '?')}</div>
      <div class="plugin-body">
        <div class="plugin-name">${escapeHtml(p.name)}</div>
        <div class="plugin-meta">${p.sizeMB} MB · ${fmtAgo(p.mtime)} · ${p.enabled ? '已启用' : '已禁用(.disabled)'}</div>
      </div>
      <label class="switch">
        <input type="checkbox" ${p.enabled ? 'checked' : ''} data-plugin="${escapeHtml(p.id)}">
        <span class="slider"></span>
      </label>
      <button class="icon-btn danger" data-pldel="${escapeHtml(p.id)}">删除</button>
    </div>`).join('');
}

/* ── Modrinth 在线搜索安装 ── */

async function pluginSearch() {
  const q = $('#pl-q').value.trim();
  if (!q) return toast('输入关键词再搜', true);
  $('#pl-results').innerHTML = '<div class="dim small" style="padding:10px 4px">搜索中…</div>';
  const d = await iapi(`/plugins/search?q=${encodeURIComponent(q)}`);
  if (!d.ok) { $('#pl-results').innerHTML = `<div class="dim small" style="padding:10px 4px">${escapeHtml(d.error)}</div>`; return; }
  if (!d.hits.length) { $('#pl-results').innerHTML = '<div class="dim small" style="padding:10px 4px">没有找到能装在当前服务端上的结果</div>'; return; }
  $('#pl-results').innerHTML = d.hits.map((h) => `
    <div class="mr-row">
      <div class="mr-icon">${h.icon ? `<img src="${escapeHtml(h.icon)}" alt="" loading="lazy">` : ico('plug')}</div>
      <div class="mr-body">
        <div class="mr-title"><a href="${escapeHtml(h.url)}" target="_blank" rel="noopener">${escapeHtml(h.title)}</a>
          <span class="dim small">by ${escapeHtml(h.author)} · ${(h.downloads / 1000).toFixed(0)}k 下载</span></div>
        <div class="dim small mr-desc">${escapeHtml(h.description)}</div>
      </div>
      <button class="icon-btn" data-mrver="${escapeHtml(h.id)}" data-mrname="${escapeHtml(h.title)}">选版本</button>
      <button class="btn btn-blue small-btn" data-mrinstall="${escapeHtml(h.id)}" data-mrname="${escapeHtml(h.title)}">安装最新</button>
    </div>`).join('');
}

$('#pl-go').addEventListener('click', pluginSearch);
$('#pl-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') pluginSearch(); });

async function installPlugin(projectId, name, versionId) {
  toast(`正在下载 ${name}…`);
  const r = await iapi('/plugins/install', { method: 'POST', body: { projectId, versionId } });
  if (!r.ok) return toast(r.error, true);
  toast(`已安装 ${r.filename}${r.verified ? '(校验通过)' : ''},重启实例后生效`);
  loadPlugins();
}

$('#pl-results').addEventListener('click', async (e) => {
  const ins = e.target.closest('[data-mrinstall]');
  if (ins) { ins.disabled = true; await installPlugin(ins.dataset.mrinstall, ins.dataset.mrname); ins.disabled = false; return; }
  const ver = e.target.closest('[data-mrver]');
  if (!ver) return;
  const d = await iapi(`/plugins/versions/${encodeURIComponent(ver.dataset.mrver)}`);
  if (!d.ok) return toast(d.error, true);
  const pick = prompt(
    `${ver.dataset.mrname} 可用版本` + (d.exact ? '' : '\n⚠ 没有匹配当前 MC 版本的发布,以下是全部版本,装了可能不兼容')
    + ':\n\n' + d.versions.map((v, i) => `${i + 1}. ${v.versionNumber} [${v.channel}] ${v.gameVersions.slice(0, 4).join(',')}`).join('\n')
    + '\n\n输入序号:', '1');
  if (!pick) return;
  const v = d.versions[parseInt(pick, 10) - 1];
  if (!v) return toast('序号无效', true);
  await installPlugin(ver.dataset.mrver, `${ver.dataset.mrname} ${v.versionNumber}`, v.id);
});

$('#view-plugins').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-pldel]');
  if (!del) return;
  if (!confirm(`删除 ${del.dataset.pldel} ?文件会被真的删掉。`)) return;
  const r = await iapi(`/plugins/${encodeURIComponent(del.dataset.pldel)}`, { method: 'DELETE' });
  r.ok ? (toast('已删除'), loadPlugins()) : toast(r.error, true);
});

$('#view-plugins').addEventListener('change', async (e) => {
  const input = e.target.closest('[data-plugin]');
  if (!input) return;
  const r = await iapi(`/plugins/${encodeURIComponent(input.dataset.plugin)}/toggle`, { method: 'POST' });
  if (r.ok) { toast(`${r.plugin.name} 已${r.plugin.enabled ? '启用' : '禁用'},重启实例后生效`); loadPlugins(); }
  else toast(r.error, true);
});

$('#chart-range').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-range]');
  if (!btn) return;
  chartRange = btn.dataset.range;
  $$('#chart-range button').forEach((b) => b.classList.toggle('active', b === btn));
  if (chartRange === 'day') {
    const d = await iapi('/metrics/history?range=day');
    metricsDay = (d && d.points) || [];
  }
  drawChart();
});

/* ───────── file manager ───────── */

/** 可解压的后缀,用于从压缩包名推出默认解压目录名 */
const ARCHIVE_EXT_RE = /\.(zip|mrpack|tar\.gz|tgz|tar\.bz2|tbz2|tbz|tar\.xz|txz|tar)$/i;

/** 打包/解压跑起来可能要几分钟,期间锁住工具栏,避免并发请求撞在同一目录上 */
let fmWorking = false;

function fmSelected() {
  return $$('#fm-list [data-sel]:checked').map((c) => c.dataset.sel);
}

function fmSyncSelection() {
  if (fmWorking) return;
  const boxes = $$('#fm-list [data-sel]');
  const n = fmSelected().length;
  $('#fm-selinfo').hidden = !n;
  $('#fm-selinfo').textContent = `已选 ${n} 项`;
  for (const id of ['#fm-zip', '#fm-targz', '#fm-cut', '#fm-copy', '#fm-del']) $(id).hidden = !n;

  // 全选框三态:全中 / 全不中 / 部分
  const all = $('#fm-selall');
  if (all) {
    all.checked = boxes.length > 0 && n === boxes.length;
    all.indeterminate = n > 0 && n < boxes.length;
    all.disabled = !boxes.length;
  }
}

/** 剪贴板栏。只要剪贴板非空就显示,和当前有没有选中无关 */
function fmSyncClip() {
  const bar = $('#fm-clipbar');
  bar.hidden = !fmClip;
  if (!fmClip) return;
  $('#fm-clipinfo').innerHTML =
    `已${fmClip.op === 'cut' ? '剪切' : '复制'} <b>${fmClip.names.length}</b> 项 · 来自 ${escapeHtml(fmClip.dir)}`;
  // 粘贴到源目录:剪切没意义(等于原地不动),复制是"再来一份"所以允许
  $('#fm-paste').disabled = fmClip.op === 'cut' && fmClip.dir === fmPath;
}

function fmClearClip() { fmClip = null; fmSyncClip(); renderCutMarks(); }

/** 被剪切的项在源目录里淡显,让用户知道它们正"待搬走" */
function renderCutMarks() {
  const cut = fmClip && fmClip.op === 'cut' && fmClip.dir === fmPath ? new Set(fmClip.names) : null;
  $$('#fm-list .file-row').forEach((row) => {
    row.classList.toggle('cut', !!cut && cut.has(row.dataset.name));
  });
}

function fmBusy(on, text) {
  fmWorking = on;
  $$('#view-files .files-toolbar .icon-btn').forEach((b) => { b.disabled = on; });
  if (on) {
    $('#fm-selinfo').hidden = false;
    $('#fm-selinfo').textContent = text;
  } else {
    fmSyncSelection();
  }
}

async function loadFiles(p) {
  const d = await iapi(`/files?path=${encodeURIComponent(p)}`);
  if (!d.ok) { toast(d.error, true); return; }
  fmPath = p;

  const parts = p.split('/').filter(Boolean);
  let crumb = `<button data-goto="/">root</button>`;
  let acc = '';
  parts.forEach((part, i) => {
    acc += '/' + part;
    crumb += `<span class="sep">/</span>` + (i === parts.length - 1
      ? `<span class="cur">${escapeHtml(part)}</span>`
      : `<button data-goto="${acc}">${escapeHtml(part)}</button>`);
  });
  $('#fm-crumb').innerHTML = crumb;

  const rows = d.entries.map((e2) => {
    const full = (p === '/' ? '' : p) + '/' + e2.name;
    const fico = ico(e2.type === 'dir' ? 'folder' : e2.archive ? 'archive' : 'file', 'ico fm-ico');
    const clickable = e2.type === 'dir' || !e2.binary;
    const name = escapeHtml(e2.name);
    return `
      <div class="file-row ${clickable ? 'clickable' : ''}" data-type="${e2.type}" data-binary="${e2.binary}" data-name="${name}" data-path="${escapeHtml(full)}">
        <div class="f-check"><input type="checkbox" data-sel="${name}" title="选中以打包"></div>
        <div class="f-ico">${fico}</div>
        <div class="f-name">${name}</div>
        <div class="f-size">${e2.type === 'dir' ? '—' : fmtSize(e2.size)}</div>
        <div class="f-time">${fmtAgo(e2.mtime)}</div>
        <div class="f-spacer"></div>
        <div class="f-actions">
          ${e2.archive ? `<button class="icon-btn gold" data-fext="${escapeHtml(full)}" data-fname="${name}">解压</button>` : ''}
          <button class="icon-btn" data-fdl="${escapeHtml(full)}" data-fdir="${e2.type === 'dir'}"
            title="${e2.type === 'dir' ? '打包成 tar.gz 下载' : '下载'}" aria-label="下载 ${name}">${ico('download')}</button>
          <button class="icon-btn" data-fren="${escapeHtml(full)}" data-fname="${name}"
            title="改名" aria-label="重命名 ${name}">${ico('pencil')}</button>
          <button class="icon-btn danger" data-fdel="${escapeHtml(full)}"
            title="删除" aria-label="删除 ${name}">${ico('trash')}</button>
        </div>
      </div>`;
  }).join('');
  $('#fm-list').innerHTML = rows || '<div class="empty">空目录</div>';
  fmLastIndex = null;                      // 换目录后 Shift 锚点作废
  fmSyncSelection();                       // 勾选也作废,顺手把工具栏收回去
  fmSyncClip();                            // 剪贴板跨目录存活,但"能不能粘"要重算
  renderCutMarks();
}

$('#fm-crumb').addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b) loadFiles(b.dataset.goto);
});

$('#fm-list').addEventListener('change', (e) => {
  if (e.target.matches('[data-sel]')) fmSyncSelection();
});

$('#fm-list').addEventListener('click', async (e) => {
  // 勾选框自己处理选中,别顺带把文件也打开了。
  // Shift 范围选必须折在这里 —— 另加一个监听会被下面这个 return 吞掉。
  const cell = e.target.closest('.f-check');
  if (cell) {
    const box = cell.querySelector('[data-sel]');
    if (!box) return;
    const boxes = $$('#fm-list [data-sel]');
    const idx = boxes.indexOf(box);
    // change 事件拿不到 shiftKey,所以锚点得在 click 阶段记
    if (e.shiftKey && fmLastIndex !== null && fmLastIndex !== idx) {
      const [a, b] = idx < fmLastIndex ? [idx, fmLastIndex] : [fmLastIndex, idx];
      // 和资源管理器一致:shift 是"把这一段刷成和我一样",不是简单全选
      for (let i = a; i <= b; i++) boxes[i].checked = box.checked;
      fmSyncSelection();
    }
    fmLastIndex = idx;
    return;
  }
  if (fmWorking) return toast('文件操作进行中,请稍候', true);

  const ext = e.target.closest('[data-fext]');
  if (ext) return fmExtract(ext.dataset.fext, ext.dataset.fname);

  const ren = e.target.closest('[data-fren]');
  if (ren) {
    const name = prompt('新名称:', ren.dataset.fname);
    if (!name || name === ren.dataset.fname) return;
    const r = await iapi('/files/rename', { method: 'POST', body: { path: ren.dataset.fren, name } });
    r.ok ? loadFiles(fmPath) : toast(r.error, true);
    return;
  }

  const dl = e.target.closest('[data-fdl]');
  if (dl) {
    // 和备份下载同理:交给浏览器,不走 fetch 攒 blob
    const isDir = dl.dataset.fdir === 'true';
    const name = dl.dataset.fdl.split('/').pop();
    const a = document.createElement('a');
    a.href = `/api/instances/${currentIid}/files/download?path=${encodeURIComponent(dl.dataset.fdl)}`;
    a.download = isDir ? name + '.tar.gz' : name;
    a.click();
    // 目录要先 tar 完才有数据,大世界能压好一会儿,别让用户以为没反应
    toast(isDir ? '正在打包,稍后开始下载…' : '已开始下载');
    return;
  }
  const del = e.target.closest('[data-fdel]');
  if (del) {
    if (!confirm(`删除 ${del.dataset.fdel} ?`)) return;
    const r = await iapi(`/files?path=${encodeURIComponent(del.dataset.fdel)}`, { method: 'DELETE' });
    r.ok ? loadFiles(fmPath) : toast(r.error, true);
    return;
  }
  const row = e.target.closest('.file-row');
  if (!row) return;
  if (row.dataset.type === 'dir') return loadFiles(row.dataset.path);
  if (row.dataset.binary === 'true') return toast('二进制文件无法在线编辑', true);
  fmOpenPath(row.dataset.path);
});

/** 在编辑器里打开某个文件;文件列表与「常见配置」入口共用 */
async function fmOpenPath(p) {
  const d = await iapi(`/files/content?path=${encodeURIComponent(p)}`);
  if (!d.ok) return toast(d.error, true);
  fmOpenFile = p;
  $('#fm-editor-name').textContent = p;
  $('#fm-content').value = d.content;
  $('#fm-editor').hidden = false;
  $('#fm-content').focus();
  $('#fm-editor').scrollIntoView({ block: 'nearest' });
}

$('#fm-save').addEventListener('click', async () => {
  if (!fmOpenFile) return;
  const r = await iapi('/files/content', { method: 'PUT', body: { path: fmOpenFile, content: $('#fm-content').value } });
  r.ok ? toast('文件已保存') : toast(r.error, true);
});

$('#fm-close').addEventListener('click', () => { $('#fm-editor').hidden = true; fmOpenFile = null; });

$('#fm-newfile').addEventListener('click', async () => {
  const name = prompt('新文件名:');
  if (!name) return;
  const r = await iapi('/files/create', { method: 'POST', body: { dir: fmPath, name, type: 'file' } });
  r.ok ? loadFiles(fmPath) : toast(r.error, true);
});

$('#fm-newdir').addEventListener('click', async () => {
  const name = prompt('新文件夹名:');
  if (!name) return;
  const r = await iapi('/files/create', { method: 'POST', body: { dir: fmPath, name, type: 'dir' } });
  r.ok ? loadFiles(fmPath) : toast(r.error, true);
});

/* ── 压缩包:解压 / 打包 ── */

async function fmExtract(rel, name) {
  // 默认解到同名新文件夹:整合包动辄几百个文件,直接摊在当前目录很难收拾
  const stem = name.replace(ARCHIVE_EXT_RE, '') || name;
  const sub = prompt(`解压 ${name} 到子文件夹(留空 = 直接解到当前目录):`, stem);
  if (sub === null) return;
  const folder = sub.trim();
  const dest = folder ? (fmPath === '/' ? '' : fmPath) + '/' + folder : fmPath;

  fmBusy(true, '正在解压…');
  const r = await iapi('/files/extract', { method: 'POST', body: { path: rel, dest } });
  fmBusy(false);
  if (!r.ok) return toast(r.error, true);
  toast(`已解压 ${r.files} 个文件(${fmtSize(r.bytes)})`);
  loadFiles(fmPath);
}

async function fmArchive(format) {
  const names = fmSelected();
  if (!names.length) return toast('请先勾选要打包的文件', true);
  const def = names.length === 1 ? names[0].replace(/\.[^.]+$/, '') : 'archive';
  const stem = prompt(`把选中的 ${names.length} 项打包成 ${format},压缩包名称:`, def);
  if (!stem || !stem.trim()) return;

  fmBusy(true, '正在打包…');
  const r = await iapi('/files/archive', { method: 'POST', body: { dir: fmPath, names, name: stem.trim(), format } });
  fmBusy(false);
  if (!r.ok) return toast(r.error, true);
  toast(`已生成 ${r.name}(${r.files} 个文件,${fmtSize(r.size)})`);
  loadFiles(fmPath);
}

/* ── 批量操作与剪贴板 ── */

$('#fm-selall').addEventListener('change', (e) => {
  $$('#fm-list [data-sel]').forEach((b) => { b.checked = e.target.checked; });
  fmLastIndex = null;
  fmSyncSelection();
});

function fmPutClip(op) {
  const names = fmSelected();
  if (!names.length) return;
  fmClip = { op, iid: currentIid, dir: fmPath, names };
  fmSyncClip();
  renderCutMarks();
  toast(`已${op === 'cut' ? '剪切' : '复制'} ${names.length} 项,到目标目录点「粘贴到此处」`);
}

$('#fm-cut').addEventListener('click', () => fmPutClip('cut'));
$('#fm-copy').addEventListener('click', () => fmPutClip('copy'));
$('#fm-clipclear').addEventListener('click', fmClearClip);

$('#fm-paste').addEventListener('click', fmPaste);
async function fmPaste() {
  if (!fmClip) return;
  // 换实例后剪贴板里的路径已经不属于当前实例了
  if (fmClip.iid !== currentIid) return toast('剪贴板来自其它实例,已失效', true), fmClearClip();
  if (fmClip.op === 'cut' && fmClip.dir === fmPath) return toast('已经在这个目录里了', true);

  fmBusy(true, fmClip.op === 'cut' ? '正在移动…' : '正在复制…');
  const r = await iapi('/files/transfer', {
    method: 'POST',
    body: { op: fmClip.op === 'cut' ? 'move' : 'copy', from: fmClip.dir, names: fmClip.names, to: fmPath },
  });
  fmBusy(false);

  if (r.done && r.done.length) {
    // 有被自动改名的就说清楚,免得用户以为没粘上
    const renamed = r.done.filter((d) => d.as !== d.name);
    toast(`已${fmClip.op === 'cut' ? '移动' : '复制'} ${r.done.length} 项`
      + (renamed.length ? `,${renamed.length} 项因重名改为「${renamed[0].as}」等` : ''));
  }
  if (r.failed && r.failed.length) {
    toast(`${r.failed.length} 项失败:${r.failed.slice(0, 2).map((f) => `${f.name}(${f.error})`).join('、')}`, true);
  } else if (!r.done) {
    return toast(r.error || '操作失败', true);
  }
  if (fmClip.op === 'cut') fmClearClip();       // 剪切是一次性的,复制可以连续粘
  loadFiles(fmPath);
}

$('#fm-del').addEventListener('click', async () => {
  const names = fmSelected();
  if (!names.length) return;
  const preview = names.slice(0, 3).join('、') + (names.length > 3 ? ` 等 ${names.length} 项` : '');
  if (!confirm(`删除 ${preview}?目录会连同里面的内容一起删掉,不可恢复。`)) return;

  fmBusy(true, '正在删除…');
  const r = await iapi('/files/batch', { method: 'DELETE', body: { dir: fmPath, names } });
  fmBusy(false);
  if (r.done && r.done.length) toast(`已删除 ${r.done.length} 项`);
  if (r.failed && r.failed.length) toast(`${r.failed.length} 项删除失败`, true);
  else if (!r.done) return toast(r.error || '删除失败', true);
  loadFiles(fmPath);
});

/* 键盘快捷键。守卫要齐:视图不对、弹窗开着、编辑器开着(会抢 Ctrl+A)、
   焦点在输入控件里、正在跑文件操作 —— 任一命中都不接管按键。 */
document.addEventListener('keydown', (e) => {
  if (currentView !== 'files') return;
  if ($$('.modal-mask').some((m) => !m.hidden)) return;     // 让 modalBehaviour 处理
  if (!$('#fm-editor').hidden) return;
  // 守卫自己不能抛 —— e.target 未必是 Element(比如事件直接派发到 document),
  // 那样 .matches 不存在,一个 TypeError 就把整个快捷键处理器打死了
  const t = e.target;
  if (t instanceof Element && (t.matches('input, textarea, select') || t.isContentEditable)) return;
  if (fmWorking) return;

  const mod = e.metaKey || e.ctrlKey;                        // macOS 用 Cmd
  const k = e.key.toLowerCase();
  if (mod && k === 'a') { e.preventDefault(); $('#fm-selall').checked = true; $('#fm-selall').dispatchEvent(new Event('change')); return; }
  if (mod && k === 'x') { e.preventDefault(); return fmPutClip('cut'); }
  if (mod && k === 'c') { e.preventDefault(); return fmPutClip('copy'); }
  if (mod && k === 'v') { e.preventDefault(); return fmPaste(); }
  if (e.key === 'Delete' && fmSelected().length) { e.preventDefault(); return $('#fm-del').click(); }
  if (e.key === 'Escape') {
    $$('#fm-list [data-sel]').forEach((b) => { b.checked = false; });
    fmLastIndex = null;
    fmSyncSelection();
    fmClearClip();
  }
});

/* ── 账号安全:2FA / Token / 会话 ── */

$('#btn-account').addEventListener('click', () => switchView('account'));

async function loadAccount() { await Promise.all([load2fa(), loadTokens(), loadSessions()]); }

async function load2fa() {
  const d = await api('/auth/2fa');
  const on = d && d.enabled;
  $('#fa-badge').textContent = on ? '已启用' : '未启用';
  $('#fa-badge').className = `task-badge ${on ? '' : 'off'}`;
  $('#fa-setup').hidden = on;
  $('#fa-off').hidden = !on;
  $('#fa-body').innerHTML = on
    ? `已启用。剩余恢复码 <b>${d.recoveryLeft}</b> 个 —— 手机丢了就靠它们登录,用完一个少一个。`
    : '用手机上的认证器 App(如 Google Authenticator、Authy、1Password)生成动态验证码。';
}

$('#fa-setup').addEventListener('click', async () => {
  const d = await api('/auth/2fa/setup', { method: 'POST' });
  if (!d.ok) return toast(d.error, true);
  // 有意不画二维码:唯一省事的做法是把密钥拼进第三方二维码服务的 URL,
  // 那等于把 2FA 种子发给别人
  $('#fa-body').innerHTML = `
    <div style="margin-bottom:10px">在认证器 App 里选「手动输入密钥」,填:</div>
    <div class="secret-box">${escapeHtml(d.secret)}</div>
    <div class="dim small" style="margin:10px 0">
      账号名填 <code>MCSP:${escapeHtml(me.username)}</code>,类型「基于时间」。
      支持 <code>otpauth://</code> 链接的 App 也可以直接粘贴:
      <div class="secret-box small">${escapeHtml(d.otpauth)}</div>
      面板不生成二维码 —— 那需要把密钥交给第三方绘图服务。
    </div>
    <div style="display:flex;gap:8px;align-items:center;margin-top:12px">
      <input id="fa-code" inputmode="numeric" placeholder="App 上显示的 6 位码" style="width:200px" />
      <button class="btn btn-blue small-btn" id="fa-confirm">确认启用</button>
    </div>`;
  $('#fa-confirm').addEventListener('click', async () => {
    const r = await api('/auth/2fa/enable', { method: 'POST', body: { code: $('#fa-code').value.trim() } });
    if (!r.ok) return toast(r.error, true);
    alert('两步验证已启用。\n\n请把下面这些恢复码抄下来存好 —— 手机丢了时它们是唯一的进入方式,每个只能用一次,而且不会再显示第二遍:\n\n' + r.recovery.join('\n'));
    load2fa();
  });
});

$('#fa-off').addEventListener('click', async () => {
  const pw = prompt('关闭两步验证需要验证当前密码:');
  if (!pw) return;
  const r = await api('/auth/2fa/disable', { method: 'POST', body: { password: pw } });
  r.ok ? (toast('两步验证已关闭'), load2fa()) : toast(r.error, true);
});

async function loadTokens() {
  const d = await api('/auth/tokens');
  const list = (d && d.tokens) || [];
  $('#tk-list').innerHTML = list.length ? list.map((t) => `
    <div class="audit-row">
      <div class="au-time dim small">${new Date(t.createdAt).toLocaleDateString('zh-CN')}</div>
      <div class="au-user">${escapeHtml(t.name)}</div>
      <div class="au-action dim small">${t.lastUsed ? '最后使用 ' + fmtAgo(t.lastUsed) : '从未使用'}</div>
      <div></div>
      <div style="text-align:right"><button class="icon-btn danger" data-tkdel="${t.id}">撤销</button></div>
    </div>`).join('') : '<div class="empty">还没有 Token</div>';
}

$('#tk-add').addEventListener('click', async () => {
  const r = await api('/auth/tokens', { method: 'POST', body: { name: $('#tk-name').value.trim() } });
  if (!r.ok) return toast(r.error, true);
  $('#tk-name').value = '';
  prompt('Token 创建成功。请立刻复制保存 —— 面板只存摘要,这串明文不会再显示第二次:', r.token);
  loadTokens();
});
$('#tk-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-tkdel]');
  if (!b || !confirm('撤销后用它的脚本会立刻失效,确定?')) return;
  const r = await api(`/auth/tokens/${b.dataset.tkdel}`, { method: 'DELETE' });
  r.ok ? (toast('已撤销'), loadTokens()) : toast(r.error, true);
});

async function loadSessions() {
  const d = await api('/auth/sessions');
  const list = (d && d.sessions) || [];
  $('#ss-list').innerHTML = list.map((sx) => `
    <div class="audit-row">
      <div class="au-time dim small">${new Date(sx.lastSeen).toLocaleString('zh-CN')}</div>
      <div class="au-user">${sx.current ? '本设备' : '其它设备'}</div>
      <div class="au-action dim small">${escapeHtml(sx.ip || '-')}</div>
      <div></div>
      <div class="au-detail dim small" title="${escapeHtml(sx.ua)}">${escapeHtml(sx.ua || '未知客户端')}
        ${sx.current ? '' : `<button class="icon-btn danger" data-ssdel="${sx.id}">踢下线</button>`}</div>
    </div>`).join('') || '<div class="empty">没有活跃会话</div>';
}
$('#ss-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-ssdel]');
  if (!b) return;
  const r = await api(`/auth/sessions/${b.dataset.ssdel}`, { method: 'DELETE' });
  r.ok ? (toast('已踢下线'), loadSessions()) : toast(r.error, true);
});
$('#ss-others').addEventListener('click', async () => {
  if (!confirm('退出除本设备外的所有登录?')) return;
  const r = await api('/auth/sessions/revoke-others', { method: 'POST' });
  r.ok ? (toast(`已退出 ${r.killed} 个会话`), loadSessions()) : toast(r.error, true);
});

/* ── 面板版本与更新检查 ── */

async function checkVersion(force) {
  const el = $('#version-line');
  if (force) el.textContent = '检查中…';
  const v = await api(`/version${force ? '?force=1' : ''}`);
  if (!v || !v.ok) { el.textContent = 'v?'; return; }
  if (v.hasUpdate) {
    el.innerHTML = `v${escapeHtml(v.current)} · <a href="${v.url}" target="_blank" rel="noopener" class="upd">有新版 ${escapeHtml(v.latest)}</a>`;
  } else if (v.latest) {
    el.textContent = `v${v.current} · 已是最新`;
  } else {
    // 查不到就说查不到,别显示"已是最新" —— 那会让人以为检查过了
    el.textContent = `v${v.current} · 更新状态未知`;
  }
}
$('#version-line').addEventListener('click', () => checkVersion(true));

/* ── 协作者 ── */

function renderCollab(status) {
  const mine = me && (me.role === 'admin' || me.username === status.owner);
  $('#collab-card').hidden = !mine;          // 协作者自己看不到也改不了这张卡
  if (!mine) return;
  $('#collab-owner').textContent = `主人:${status.owner}`;
  const list = normCollab(status.collaborators);
  $('#collab-list').innerHTML = list.length
    ? list.map((c) => `
      <span class="tag">
        ${escapeHtml(c.name)}
        <select data-cbrole="${escapeHtml(c.name)}" title="权限档"
                style="margin:0 4px;padding:1px 4px;font-size:11px">
          ${COLLAB_ROLES.map(([v, label]) =>
            `<option value="${v}"${c.role === v ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <button data-cbdel="${escapeHtml(c.name)}" title="移除">×</button>
      </span>`).join('')
    : '<div class="empty">还没有协作者。加一个面板用户,他就能和你一起管这个实例。</div>';
}

const COLLAB_ROLES = [['viewer', '只读'], ['operator', '运维'], ['manager', '管理']];

/** 后端已统一返回 [{name,role}],但缓存里可能还留着老的字符串数组 */
const normCollab = (list) => (list || []).map((c) => (typeof c === 'string'
  ? { name: c, role: 'manager' } : c));

async function saveCollab(users) {
  const r = await iapi('/collaborators', { method: 'PUT', body: { users } });
  if (!r.ok) return toast(r.error, true);
  const st = instMap.get(currentIid);
  if (st) st.collaborators = r.collaborators;
  renderCollab({ owner: st ? st.owner : '', collaborators: r.collaborators });
  toast('协作者已更新');
}

$('#cb-add').addEventListener('click', () => {
  const n = $('#cb-input').value.trim();
  if (!n) return;
  const cur = normCollab((instMap.get(currentIid) || {}).collaborators);
  if (cur.some((c) => c.name === n)) return toast('已经在名单里了', true);
  $('#cb-input').value = '';
  // 默认给最低档:加人的时候顺手给到最大权限,是这类功能最常见的事故来源
  saveCollab([...cur, { name: n, role: $('#cb-role').value || 'viewer' }]);
});
$('#collab-list').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cbdel]');
  if (!b) return;
  const cur = normCollab((instMap.get(currentIid) || {}).collaborators);
  saveCollab(cur.filter((c) => c.name !== b.dataset.cbdel));
});
$('#collab-list').addEventListener('change', (e) => {
  const s = e.target.closest('[data-cbrole]');
  if (!s) return;
  const cur = normCollab((instMap.get(currentIid) || {}).collaborators);
  saveCollab(cur.map((c) => (c.name === s.dataset.cbrole ? { ...c, role: s.value } : c)));
});

/* ── 服务器图标 ── */

async function loadServerIcon() {
  const d = await iapi('/files?path=/');
  const has = d.ok && d.entries.some((e) => e.name === 'server-icon.png');
  $('#ic-del').hidden = !has;
  $('#ic-preview').innerHTML = has
    // 带上时间戳,不然换了图还是显示浏览器缓存里那张
    ? `<img src="/api/instances/${currentIid}/files/download?path=%2Fserver-icon.png&t=${Date.now()}" alt="server-icon">`
    : '<span class="dim small">未设置</span>';
}

$('#ic-pick').addEventListener('click', () => $('#ic-input').click());
$('#ic-input').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.type !== 'image/png') return toast('必须是 PNG', true);
  // 先在浏览器里量一下尺寸,不合规就别浪费一次上传 —— 服务端也只会默默忽略
  const dim = await new Promise((res) => {
    const img = new Image();
    img.onload = () => res([img.naturalWidth, img.naturalHeight]);
    img.onerror = () => res(null);
    img.src = URL.createObjectURL(f);
  });
  if (!dim) return toast('不是有效的 PNG', true);
  if (dim[0] !== 64 || dim[1] !== 64) {
    return toast(`必须是 64×64,当前是 ${dim[0]}×${dim[1]} —— Minecraft 会忽略尺寸不对的图标`, true);
  }
  const r = await uploadOne(f, '/', true, () => {});
  if (!r.ok) return toast(r.error, true);
  // 上传接口按原文件名保存,这里要的是固定名,传完改一下
  if (f.name !== 'server-icon.png') {
    const rn = await iapi('/files/rename', { method: 'POST', body: { path: '/' + f.name, name: 'server-icon.png' } });
    if (!rn.ok) return toast(`已上传但改名失败: ${rn.error}`, true);
  }
  toast('图标已更新,重启实例后生效');
  loadServerIcon();
  renderCollab(status);
});

$('#ic-del').addEventListener('click', async () => {
  if (!confirm('删除 server-icon.png ?')) return;
  const r = await iapi('/files?path=%2Fserver-icon.png', { method: 'DELETE' });
  r.ok ? (toast('已删除'), loadServerIcon()) : toast(r.error, true);
});

/* ── 常见配置文件快捷入口 ── */

async function loadConfigs() {
  const d = await iapi('/configs');
  const list = (d && d.configs) || [];
  $('#cfg-files-card').hidden = !list.length;
  if (!list.length) return;
  $('#cfg-files').innerHTML = list.map((c) => `
    <div class="cfgfile-row">
      <div class="cf-name">${escapeHtml(c.name)}</div>
      <div class="cf-desc dim small">${escapeHtml(c.desc)}</div>
      <div class="cf-meta dim small">${fmtSize(c.size)} · ${fmtAgo(c.mtime)}</div>
      <button class="icon-btn" data-cfgedit="${escapeHtml(c.path)}">编辑</button>
    </div>`).join('');
}

$('#cfg-files').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-cfgedit]');
  if (!btn) return;
  const p = btn.dataset.cfgedit;
  // 先把 fmPath 挪到目标目录再切视图:switchView 自己会用 fmPath 触发一次加载,
  // 不先设的话它加载的是旧目录,而且会后于我们这次渲染落地,把面包屑冲掉
  fmPath = p.slice(0, p.lastIndexOf('/')) || '/';
  switchView('files');
  await loadFiles(fmPath);
  fmOpenPath(p);
});

/* ── 重装 / 升级 ── */

async function loadReinstall(status) {
  if (!(await fillTypes('#ri-type', status.type))) return;
  await fillVersions('#ri-type', '#ri-version', status.version);
  const info = (serverTypes || []).find((x) => x.key === $('#ri-type').value);
  $('#ri-hint').textContent = `当前:${typeLabel(status.type)} ${status.version}`
    + (info && info.note ? ` · ⓘ ${info.note}` : '');
}

$('#ri-type').addEventListener('change', async () => {
  await fillVersions('#ri-type', '#ri-version');
  const info = (serverTypes || []).find((x) => x.key === $('#ri-type').value);
  const cur = instMap.get(currentIid);
  $('#ri-hint').textContent = (cur ? `当前:${typeLabel(cur.type)} ${cur.version}` : '')
    + (info && info.note ? ` · ⓘ ${info.note}` : '');
});

$('#ri-go').addEventListener('click', async () => {
  const cur = instMap.get(currentIid);
  const type = $('#ri-type').value;
  const version = $('#ri-version').value;
  if (!version) return toast('版本列表尚未加载', true);
  if (cur && cur.state !== 'stopped') return toast('请先停止实例再重装', true);
  const backup = $('#ri-backup').checked;

  const from = cur ? `${typeLabel(cur.type)} ${cur.version}` : '当前版本';
  const warn = backup ? '' : '\n\n你已关闭自动备份 —— 出问题将无法回滚!';
  if (!confirm(`确定把实例从 ${from} 换成 ${typeLabel(type)} ${version} ?\n\n`
    + `世界、插件、server.properties 会保留。\n`
    + `注意 Minecraft 不支持世界降级,换到更低版本可能损坏存档。${warn}`)) return;

  const body = { type, version, backup, eula: true };
  const btn = $('#ri-go');
  btn.disabled = true;
  const r = await iapi('/reinstall', { method: 'POST', body });
  btn.disabled = false;
  if (r.ok) toast(backup ? '已开始:先备份再重装,进度看控制台' : '已开始重装,进度看控制台');
  else toast(r.error, true);
});

/* Aikar's Flags:MC 服务端调优的事实标准,手打太长,给个一键填入 */
const AIKAR_FLAGS = "-XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:+UnlockExperimentalVMOptions -XX:+DisableExplicitGC -XX:+AlwaysPreTouch -XX:G1NewSizePercent=30 -XX:G1MaxNewSizePercent=40 -XX:G1HeapRegionSize=8M -XX:G1ReservePercent=20 -XX:G1HeapWastePercent=5 -XX:G1MixedGCCountTarget=4 -XX:InitiatingHeapOccupancyPercent=15 -XX:G1MixedGCLiveThresholdPercent=90 -XX:G1RSetUpdatingPauseTimePercent=5 -XX:SurvivorRatio=32 -XX:+PerfDisableSharedMem -XX:MaxTenuringThreshold=1 -Dusing.aikars.flags=https://mcflags.emc.gs -Daikars.new.flags=true";
$('#cfg-jvm-aikar').addEventListener('click', () => { $('#cfg-jvm').value = AIKAR_FLAGS; });
$('#cfg-jvm-clear').addEventListener('click', () => { $('#cfg-jvm').value = ''; });

$('#fm-zip').addEventListener('click', () => fmArchive('zip'));
$('#fm-targz').addEventListener('click', () => fmArchive('tar.gz'));

/* ── 上传:XHR(要 upload.progress,fetch 给不了)· body 就是文件本身 ──
 *
 * 大文件走分片。原因是反代:面板常被架在隧道 / Cloudflare Worker 后面,这类链路
 * 在请求体 10 MB 出头就直接 502(请求压根到不了面板)。小文件仍一次传完 —— 省掉
 * init/finish 两次往返,一堆配置文件那种场景差别很明显。
 */

/* 全局在途上传请求数闸门。
 *
 * 关键:**只有真正的 HTTP 请求占槽位**,uploadChunked 这层编排不占。否则
 * 3 个大文件各占一个槽、又都在等自己的分片要槽,就地死锁。 */
function makeLimiter(n) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= n || !queue.length) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
}
let uploadGate = makeLimiter(3);        // init() 拿到服务端配置后会重建

/** 一次 XHR,统一解析 {ok,...} / HTTP 状态。onProgress 收到的是本次请求已发字节数 */
function uploadXhr({ method = 'POST', url, body, json, onProgress }) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.setRequestHeader('Content-Type', json ? 'application/json' : 'application/octet-stream');
    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => { if (e.lengthComputable) onProgress(e.loaded); });
    }
    xhr.addEventListener('load', () => {
      if (xhr.status === 401) { location.href = '/login'; return resolve({ ok: false, error: '会话已过期', status: 401 }); }
      let r = null;
      try { r = JSON.parse(xhr.responseText); } catch {}
      // 成功时别留下 error 字段 —— 调用方写 if (r.error) 就会被一个"HTTP 200"坑到
      if (r && r.ok) return resolve({ ...r, status: xhr.status });
      resolve({ ok: false, error: (r && r.error) || `HTTP ${xhr.status}`, status: xhr.status });
    });
    xhr.addEventListener('error', () => resolve({ ok: false, error: '网络错误', status: 0 }));
    xhr.addEventListener('abort', () => resolve({ ok: false, error: '已取消', status: 0 }));
    xhr.send(json ? JSON.stringify(body) : body);
  });
}

/* iid 可指定 —— 导入流程要传给刚建好的空壳实例,而不是当前选中的那个 */
function uploadOne(file, dir, overwrite, onProgress, iid = null) {
  const chunkMB = (uploadCfg && uploadCfg.chunkMB) || 5;
  if (file.size > chunkMB * 1048576) return uploadChunked(file, dir, overwrite, onProgress, iid);
  return uploadWhole(file, dir, overwrite, onProgress, iid);
}

/** 一次传完(小文件 / 老路径) */
function uploadWhole(file, dir, overwrite, onProgress, iid) {
  const q = `?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`;
  return uploadGate(() => uploadXhr({
    url: `/api/instances/${iid || currentIid}/files/upload${q}`,
    body: file,
    onProgress: (loaded) => onProgress(loaded / (file.size || 1)),
  }));
}

/** 分片传:init → 并发 chunk → finish */
async function uploadChunked(file, dir, overwrite, onProgress, iid) {
  const base = `/api/instances/${iid || currentIid}/files/upload`;

  const init = await uploadGate(() => uploadXhr({
    url: `${base}/init`, json: true,
    body: { path: dir, name: file.name, size: file.size, overwrite: !!overwrite },
  }));
  if (!init.ok) return init;

  /* 切片一律按 init 返回的 chunkSize —— 不能用本地那份配置。页面加载之后服务端
     配置被改过的话,照旧值切出来的片会每一片都被判长度不符 */
  const { uploadId, chunkSize, chunks } = init;
  const loaded = new Array(chunks).fill(0);
  let lastPct = -1;
  const report = () => {
    const sum = loaded.reduce((a, b) => a + b, 0);
    const pct = Math.floor((sum / file.size) * 100);
    // 重传会把某片的 loaded 清零,进度条倒退看着就像出 bug 了 —— 只准往前走
    if (pct > lastPct) { lastPct = pct; onProgress(sum / file.size); }
  };

  let failure = null;
  await Promise.all(Array.from({ length: chunks }, async (_, i) => {
    const start = i * chunkSize;
    const blob = file.slice(start, Math.min(start + chunkSize, file.size));
    for (let attempt = 0; attempt < 3; attempt++) {
      if (failure) return;                       // 已经有片彻底失败了,别再白传
      if (attempt) await new Promise((r) => setTimeout(r, [500, 1500, 4000][attempt - 1]));
      loaded[i] = 0;
      const r = await uploadGate(() => uploadXhr({
        url: `${base}/chunk?uploadId=${uploadId}&index=${i}`,
        body: blob,
        onProgress: (n) => { loaded[i] = n; report(); },
      }));
      if (r.ok) { loaded[i] = blob.size; report(); return; }
      /* 会话没了 —— 后面每一片都会同样 404,重试纯属拖延。直接判整个文件失败 */
      if (r.status === 404) { failure = r.error; return; }
      // 4xx 是确定性的,重试不会有不同结果;只有网络错误和 5xx 值得再来一次
      if (r.status >= 400 && r.status < 500) { failure = r.error; return; }
      if (attempt === 2) failure = r.error;
    }
  }));

  if (failure) {
    uploadGate(() => uploadXhr({ url: `${base}/abort`, json: true, body: { uploadId } })).catch(() => {});
    return { ok: false, error: failure };
  }

  const fin = await uploadGate(() => uploadXhr({ url: `${base}/finish`, json: true, body: { uploadId } }));
  if (fin.ok) onProgress(1);
  return fin;
}

async function uploadFiles(fileList) {
  // 必须先拷成数组:FileList 是 input.files 的实时引用,
  // 调用方一清空 input.value 它就空了,循环会从第二个文件起全部漏掉
  const files = [...fileList];
  if (!files.length) return;
  const dir = fmPath;
  // 同名一次问清楚,免得传了几百 MB 才在 409 上卡住
  const existing = new Set($$('#fm-list .file-row').map((r) => r.dataset.name));
  const dupes = files.filter((f) => existing.has(f.name));
  if (dupes.length && !confirm(`以下文件已存在,覆盖?\n${dupes.map((f) => f.name).join('\n')}`)) return;

  const box = $('#fm-uploads');
  box.hidden = false;
  box.innerHTML = files.map((f, i) => `
    <div class="up-row" data-up="${i}">
      <div class="up-name">${escapeHtml(f.name)}</div>
      <div class="up-bar"><i></i></div>
      <div class="up-pct">等待…</div>
    </div>`).join('');

  /* 所有文件一起开跑,真正的并发上限由 uploadGate 统一卡着 —— 这里不能再套一层
     限流:编排任务占了槽位再去等分片的槽位就会死锁 */
  const results = await Promise.all(files.map(async (f, i) => {
    const row = box.querySelector(`[data-up="${i}"]`);
    const bar = row.querySelector('.up-bar i');
    const pct = row.querySelector('.up-pct');
    const r = await uploadOne(f, dir, existing.has(f.name), (p) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      pct.textContent = `${Math.round(p * 100)}%`;
    });
    row.classList.add(r.ok ? 'done' : 'fail');
    bar.style.width = '100%';
    pct.textContent = r.ok ? '完成' : r.error;
    pct.title = r.ok ? '' : r.error;      // 错误文案比列宽长,截断后靠 tooltip 看全
    return r;
  }));
  const failed = results.filter((r) => !r.ok).length;

  if (dir === fmPath) loadFiles(fmPath);
  toast(failed ? `${files.length - failed} 个成功,${failed} 个失败` : `${files.length} 个文件已上传`, !!failed);
  setTimeout(() => { box.hidden = true; box.innerHTML = ''; }, failed ? 8000 : 2500);
}

$('#fm-upload').addEventListener('click', () => $('#fm-file-input').click());

$('#fm-file-input').addEventListener('change', (e) => {
  uploadFiles(e.target.files);
  e.target.value = '';                    // 同一个文件再选一次也能触发 change
});

/* 拖拽上传:dragenter/leave 会在子元素间乱跳,用计数器判断真正离开卡片 */
let fmDragDepth = 0;
const fmCard = $('#view-files .files-card');

fmCard.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  if (++fmDragDepth === 1) $('#fm-dropmask').hidden = false;
});
fmCard.addEventListener('dragover', (e) => {
  if (e.dataTransfer.types.includes('Files')) e.preventDefault();
});
fmCard.addEventListener('dragleave', () => {
  if (--fmDragDepth <= 0) { fmDragDepth = 0; $('#fm-dropmask').hidden = true; }
});
fmCard.addEventListener('drop', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  e.preventDefault();
  fmDragDepth = 0;
  $('#fm-dropmask').hidden = true;
  // 拖进来的目录在 .files 里也是一个 File(大小 0),传上去只会得到一个空文件
  const entries = [...e.dataTransfer.items].map((it) => (it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
  const files = [...e.dataTransfer.files].filter((_, i) => !entries[i] || !entries[i].isDirectory);
  if (files.length < e.dataTransfer.files.length) toast('已跳过文件夹,暂不支持整目录上传', true);
  uploadFiles(files);
});

/* ───────── scheduled tasks ───────── */

const ACTION_TEXT = { restart: '重启实例', backup: '创建备份', command: '执行命令', start: '启动实例', stop: '停止实例' };

$('#task-action').addEventListener('change', (e) => {
  $('#task-payload').hidden = e.target.value !== 'command';
});
$('#task-sched-type').addEventListener('change', (e) => {
  $('#task-minutes').hidden = e.target.value !== 'interval';
  $('#task-time').hidden = e.target.value !== 'daily';
});

async function loadTasks() {
  const list = await iapi('/tasks');
  $('#task-list').innerHTML = list.length ? list.map((t) => `
    <div class="backup-item">
      <div class="backup-ico">${ico('clock')}</div>
      <div>
        <div class="backup-name">${escapeHtml(t.name)} <span class="task-badge ${t.enabled ? '' : 'off'}">${t.enabled ? '启用' : '停用'}</span></div>
        <div class="backup-meta">${ACTION_TEXT[t.action]}${t.payload ? ` · /${escapeHtml(t.payload)}` : ''} · ${t.scheduleText} · 上次执行 ${t.lastRun ? fmtAgo(t.lastRun) : '从未'}</div>
        ${t.lastResult ? `<div class="backup-meta task-result ${t.lastResult.ok ? 'ok' : 'bad'}">
          ${t.lastResult.ok ? '✔' : '✘'} ${escapeHtml(t.lastResult.msg || '')}
          ${t.failStreak > 1 ? `<b>· 已连续 ${t.failStreak} 次未成功</b>` : ''}
        </div>` : ''}
      </div>
      <div class="spacer"></div>
      <button class="icon-btn" data-tact="run" data-id="${t.id}">立即执行</button>
      <button class="icon-btn" data-tact="toggle" data-id="${t.id}">${t.enabled ? '停用' : '启用'}</button>
      <button class="icon-btn danger" data-tact="del" data-id="${t.id}">删除</button>
    </div>`).join('') : '<div class="empty">暂无计划任务。用上方表单创建第一个自动化任务。</div>';
}

$('#task-create').addEventListener('click', async () => {
  const schedType = $('#task-sched-type').value;
  const r = await iapi('/tasks', {
    method: 'POST',
    body: {
      name: $('#task-name').value,
      action: $('#task-action').value,
      payload: $('#task-payload').value,
      schedule: schedType === 'interval'
        ? { type: 'interval', minutes: $('#task-minutes').value }
        : { type: 'daily', time: $('#task-time').value },
    },
  });
  if (r.ok) { $('#task-name').value = ''; toast('任务已创建'); loadTasks(); }
  else toast(r.error, true);
});

$('#task-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-tact]');
  if (!btn) return;
  const { tact, id } = btn.dataset;
  if (tact === 'del') {
    await iapi(`/tasks/${id}`, { method: 'DELETE' });
    toast('任务已删除');
  } else if (tact === 'toggle') {
    await iapi(`/tasks/${id}/toggle`, { method: 'POST' });
  } else if (tact === 'run') {
    const r = await iapi(`/tasks/${id}/run`, { method: 'POST' });
    // 直接回显结果 —— "已触发"什么都没说明,任务很可能因为状态不对根本没干活
    if (r && r.result) toast(`${r.result.ok ? '执行完成' : '未生效'}: ${r.result.msg}`, !r.result.ok);
    else toast('已触发执行');
  }
  loadTasks();
});

/* ───────── tunnel ───────── */

const COMPONENT_META = {
  bore: ['⚡', 'GitHub ekzhang/bore · '],
  playit: ['🎮', 'GitHub playit-cloud · '],
  ngrok: ['🛰️', '官方源 bin.equinox.io · '],
  frpc: ['🔗', 'GitHub fatedier/frp · '],
  ssh: ['🔑', ''],
};

function renderTunnelComponents(comp) {
  const rows = ['bore', 'playit', 'ngrok', 'frpc', 'ssh'].map((name) => {
    const c = comp[name];
    if (!c) return '';
    let action;
    if (c.builtin) {
      action = c.installed
        ? (c.pubkey ? `<button class="icon-btn" data-pubkey="${escapeHtml(c.pubkey)}">复制公钥</button> <span class="task-badge">系统自带</span>` : '<span class="task-badge">系统自带</span>')
        : '<span class="task-badge off">系统缺少 ssh</span>';
    }
    else if (c.installing) action = `<span class="task-badge">下载中 ${c.progress}%</span>`;
    else if (c.installed) action = `<span class="task-badge">已安装</span>`;
    else if (me && me.role === 'admin') action = `<button class="btn btn-blue small-btn" data-comp="${name}">下载安装</button>`;
    else action = '<span class="task-badge off">需管理员安装</span>';
    const [compIco, source] = COMPONENT_META[name];
    // 名字归名字,用途归副标题 —— 别让一行同时干两件事
    const label = { playit: 'playit.gg' }[name] || name;
    const note = name === 'ssh' ? 'Pinggy / Serveo 需要' : '';
    return `
      <div class="backup-item">
        <div class="backup-ico">${compIco}</div>
        <div>
          <div class="backup-name">${label}</div>
          <div class="backup-meta">${[note, c.installed ? escapeHtml(c.version || '') : source + comp.arch].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="spacer"></div>
        ${action}
      </div>`;
  }).join('');
  $('#tunnel-components').innerHTML = rows;
}

function applyTunnelStatus(t) {
  const [txt, cls] = TUNNEL_STATE_TEXT[t.state] || TUNNEL_STATE_TEXT.stopped;
  $('#tn-state').className = `pill ${cls}`;
  $('#tn-state').textContent = txt;
  $('#tn-addr').hidden = !t.addr;
  $('#tn-copy').hidden = !t.addr;
  $('#tn-check').hidden = !t.addr;
  if (t.addr) $('#tn-addr').textContent = t.addr;
  $('#tn-start').disabled = t.state !== 'stopped';
  $('#tn-stop').disabled = t.state === 'stopped';
  const claim = $('#tn-claim');
  claim.hidden = !t.claim;
  if (t.claim) {
    claim.href = t.claim;
    $('#tn-state').textContent = '等待绑定账户';
  }
  const err = $('#tn-error');
  err.hidden = !t.error || t.state === 'running';
  if (t.error) err.textContent = '上次启动失败:' + t.error;
  if (t.rcon) applyRconTunnelStatus(t.rcon);
}

/* RCON 隧道:状态徽章用 on/off 而不是 pill —— 运行中要显眼,
   因为"还开着"本身就是需要留意的状态 */
function applyRconTunnelStatus(r) {
  const badge = $('#tnr-state');
  if (!badge) return;
  const running = r.state === 'running';
  badge.textContent = running ? '公网可访问' : (r.state === 'starting' ? '连接中…' : '未启动');
  badge.className = `task-badge ${running ? 'on' : 'off'}`;
  $('#tnr-addr').hidden = !r.addr;
  $('#tnr-copy').hidden = !r.addr;
  if (r.addr) $('#tnr-addr').textContent = r.addr;
  $('#tnr-start').disabled = r.state !== 'stopped';
  $('#tnr-stop').disabled = r.state === 'stopped';
  const e = $('#tnr-error');
  e.hidden = !r.error || running;
  if (r.error) e.textContent = '上次启动失败:' + r.error;
}

async function loadTunnel() {
  const [comp, cfg] = await Promise.all([api('/tunnel/components'), iapi('/tunnel')]);
  renderTunnelComponents(comp);
  const c = cfg.config;
  $('#tn-type').value = c.type;
  $('#tn-ngrok-token').value = c.ngrok.authtoken || '';
  $('#tn-frpc-addr').value = c.frpc.serverAddr || '';
  $('#tn-frpc-port').value = c.frpc.serverPort || '';
  $('#tn-frpc-token').value = c.frpc.token || '';
  $('#tn-frpc-user').value = c.frpc.user || '';
  $('#tn-frpc-meta').value = c.frpc.metaToken || '';
  $('#tn-frpc-rport').value = c.frpc.remotePort || '';
  $('#tn-bore-server').value = (c.bore && c.bore.server) || 'bore.pub';
  $('#tn-bore-secret').value = (c.bore && c.bore.secret) || '';
  $('#tn-bore-rport').value = (c.bore && c.bore.remotePort) || '';
  $('#tn-pinggy-token').value = (c.pinggy && c.pinggy.token) || '';
  $('#tn-serveo-rport').value = (c.serveo && c.serveo.remotePort) || '';
  $('#tnr-port').value = (c.rcon && c.rcon.remotePort) || '';
  toggleTunnelForm();
  applyTunnelStatus({
    state: cfg.state, addr: cfg.addr, error: cfg.error, claim: cfg.claim,
    rcon: cfg.rcon || { state: 'stopped' },
  });
}

function toggleTunnelForm() {
  const t = $('#tn-type').value;
  $('#tn-bore').hidden = t !== 'bore';
  $('#tn-playit').hidden = t !== 'playit';
  $('#tn-pinggy').hidden = t !== 'pinggy';
  $('#tn-serveo').hidden = t !== 'serveo';
  $('#tn-ngrok').hidden = t !== 'ngrok';
  $('#tn-frpc').hidden = t !== 'frpc';
}
$('#tn-type').addEventListener('change', toggleTunnelForm);

$('#tunnel-components').addEventListener('click', async (e) => {
  const pk = e.target.closest('[data-pubkey]');
  if (pk) {
    try { await navigator.clipboard.writeText(pk.dataset.pubkey); toast('面板 SSH 公钥已复制,可注册到 Serveo 等服务'); }
    catch { toast('复制失败', true); }
    return;
  }
  const btn = e.target.closest('[data-comp]');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '下载中…';
  toast(`开始下载 ${btn.dataset.comp},请稍候`);
  const r = await api(`/tunnel/components/${btn.dataset.comp}/install`, { method: 'POST' });
  if (r.ok) { toast(`${btn.dataset.comp} 安装完成`); renderTunnelComponents(r.components); }
  else { toast(r.error, true); loadTunnel(); }
});

/** 穿透表单的完整载荷。PUT 是整体覆盖,所以每次都要带齐所有字段 ——
    RCON 隧道启动前也要先存一次,不能只提交它自己那一小段 */
function tunnelBody() {
  return {
    type: $('#tn-type').value,
    ngrok: { authtoken: $('#tn-ngrok-token').value.trim() },
    frpc: {
      serverAddr: $('#tn-frpc-addr').value.trim(),
      serverPort: $('#tn-frpc-port').value,
      token: $('#tn-frpc-token').value.trim(),
      user: $('#tn-frpc-user').value.trim(),
      metaToken: $('#tn-frpc-meta').value.trim(),
      remotePort: $('#tn-frpc-rport').value,
    },
    bore: {
      server: $('#tn-bore-server').value.trim() || 'bore.pub',
      secret: $('#tn-bore-secret').value.trim(),
      remotePort: $('#tn-bore-rport').value,
    },
    pinggy: { token: $('#tn-pinggy-token').value.trim() },
    serveo: { remotePort: $('#tn-serveo-rport').value },
    rcon: { remotePort: $('#tnr-port').value },
  };
}

$('#tn-save').addEventListener('click', async () => {
  const r = await iapi('/tunnel', { method: 'PUT', body: tunnelBody() });
  r.ok ? toast('穿透配置已保存') : toast(r.error, true);
});

/* RCON 隧道。开之前挡一道确认 —— 这不是"再点一次"的仪式,
   而是因为一旦开了,公网上任何人都能对着一个明文协议敲密码 */
$('#tnr-start').addEventListener('click', async () => {
  if (!confirm('即将把 RCON 端口暴露到公网。\n\n'
    + 'RCON 是明文协议:密码和命令都不加密,链路上任何人都能读到;\n'
    + '拿到 RCON 等于拿到服务器控制台(op、stop、ban…)。\n\n'
    + '用完请及时停止。确定继续吗?')) return;
  /* 只把远端端口随请求带过去,不在这里 PUT 整个穿透配置。
     踩过一次:表单只要有一处没同步(刚切进本页、或别处改过),
     那次"顺手保存"就会拿旧表单把已保存的配置整体覆盖掉 ——
     实测把 type=bore 写成了 none,隧道再也起不来。 */
  const r = await iapi('/tunnel/rcon/start', {
    method: 'POST', body: { remotePort: $('#tnr-port').value },
  });
  r.ok ? toast('RCON 隧道启动中…') : toast(r.error, true);
});

$('#tnr-stop').addEventListener('click', async () => {
  const r = await iapi('/tunnel/rcon/stop', { method: 'POST' });
  r.ok ? toast('RCON 隧道已停止') : toast(r.error, true);
});

$('#tnr-copy').addEventListener('click', async () => {
  await copyText($('#tnr-addr').textContent);
  toast('RCON 地址已复制');
});

$('#tn-start').addEventListener('click', async () => {
  const r = await iapi('/tunnel/start', { method: 'POST' });
  r.ok ? toast('隧道启动中…') : toast(r.error, true);
});

$('#tn-stop').addEventListener('click', async () => {
  const r = await iapi('/tunnel/stop', { method: 'POST' });
  r.ok ? toast('隧道已停止') : toast(r.error, true);
});

$('#tn-check').addEventListener('click', async () => {
  const btn = $('#tn-check');
  btn.disabled = true; btn.textContent = '检测中…';
  const r = await iapi('/tunnel/check', { method: 'POST' });
  btn.disabled = false; btn.textContent = '测试连通性';
  if (!r.ok) return toast(r.error, true);
  if (r.reachable) toast(`✔ 公网可达${r.version ? ' · ' + r.version : ''},玩家可以直接连接`);
  else toast(`✘ 公网不可达:${r.error}`, true);
});

$('#tn-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#tn-addr').textContent);
    toast('公网地址已复制');
  } catch {
    toast('复制失败,请手动选择', true);
  }
});

/* ───────── backups ───────── */

async function loadBackups() {
  loadCrashes();
  const backups = await iapi('/backups');
  // 增量链在列表里要一眼看得出来:哪份是基准、哪份挂在它下面
  const hasChain = backups.some((b) => b.type === 'inc');
  $('#bk-inc-note').textContent = hasChain ? '含增量链 —— 恢复增量会自动按顺序应用整条链' : '';
  $('#backup-list').innerHTML = backups.length ? backups.map((b) => `
    <div class="backup-item">
      <div class="backup-ico">${ico('archive')}</div>
      <div>
        <div class="backup-name">
          ${escapeHtml(b.name)}
          ${b.type === 'inc'
            ? `<span class="task-badge off" title="基于 ${escapeHtml(b.base || '')}">增量 #${b.seq}</span>`
            : (hasChain ? '<span class="task-badge on">全量基准</span>' : '')}
        </div>
        <div class="backup-meta">${fmtSize(b.size)} · ${fmtAgo(b.createdAt)}</div>
      </div>
      <div class="spacer"></div>
      <button class="icon-btn" data-bact="download" data-id="${b.id}">下载</button>
      <button class="icon-btn" data-bact="restore" data-id="${b.id}">恢复</button>
      <button class="icon-btn danger" data-bact="delete" data-id="${b.id}">删除</button>
    </div>`).join('') : '<div class="empty">暂无备份</div>';
}

async function runBackup(mode) {
  toast(mode === 'incremental' ? '正在做增量备份…' : '正在做全量备份…');
  const r = await iapi('/backups', { method: 'POST', body: { mode } });
  if (!r.ok) return toast(r.error, true);
  // 如实回报实际做了哪种:请求增量但没有基准链时后端会落回全量,
  // 不说清楚的话用户对磁盘增长的预期就是错的
  const fellBack = mode === 'incremental' && r.mode === 'full';
  toast(fellBack
    ? `已改做全量备份(${r.sizeMB} MB)—— 还没有可追加的基准链`
    : `${r.mode === 'incremental' ? '增量' : '全量'}备份完成(${r.sizeMB} MB)`);
  loadBackups();
}

$('#backup-create').addEventListener('click', () => runBackup('full'));
$('#backup-create-inc').addEventListener('click', () => runBackup('incremental'));

/* ───────── 在线时长 ───────── */

/** 时长文案:3 天 4 小时 / 5 小时 12 分 / 8 分钟 —— 秒级对这个场景没意义 */
function fmtDuration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时 ${m % 60} 分`;
  return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
}

async function loadPlaytime() {
  const r = await iapi('/playtime');
  const rows = r.players || [];
  const box = $('#playtime-list');
  if (!rows.length) {
    box.innerHTML = '<div class="empty">还没有记录。玩家进出服务器后会在这里累计。</div>';
    return;
  }
  const max = rows[0].totalMs || 1;
  box.innerHTML = rows.slice(0, 50).map((p) => `
    <div class="disk-row">
      <div class="d-name">${p.online ? '<span style="color:var(--green)">●</span> ' : ''}${escapeHtml(p.name)}</div>
      <div class="d-bar"><i style="width:${Math.max(2, Math.round((p.totalMs / max) * 100))}%"></i></div>
      <div class="d-size">${fmtDuration(p.totalMs)}</div>
      <div class="d-detail dim small">${p.sessions} 次 · 最后 ${p.lastSeen ? fmtAgo(p.lastSeen) : '—'}</div>
    </div>`).join('');
}

$('#pt-reset').addEventListener('click', async () => {
  if (!confirm('清空这个实例的所有在线时长统计?此操作不可撤销。')) return;
  await iapi('/playtime', { method: 'DELETE' });
  toast('时长统计已重置');
  loadPlaytime();
});

/* ───────── 崩溃现场 ───────── */

async function loadCrashes() {
  const r = await iapi('/crashes');
  const rows = (r.crashes || []);
  $('#crash-list').innerHTML = rows.length ? rows.map((c) => `
    <div class="backup-item">
      <div class="backup-ico">${ico('activity')}</div>
      <div>
        <div class="backup-name">${fmtAgo(c.at)} <span class="dim small">${new Date(c.at).toLocaleString()}</span></div>
        <div class="backup-meta">
          退出码 ${c.exitCode === null ? '—' : c.exitCode}${c.signal ? ` · 信号 ${escapeHtml(c.signal)}` : ''}
          · 日志 ${c.tailLines} 行
          ${c.report ? `· <span style="color:var(--blue)">含服务端崩溃报告</span>` : '· 无服务端报告'}
        </div>
      </div>
      <div class="spacer"></div>
      <button class="icon-btn" data-crash="${c.index}">查看</button>
    </div>`).join('') : '<div class="empty">还没有崩溃记录 —— 这是好事</div>';
}

$('#crash-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-crash]');
  if (!btn) return;
  const r = await iapi(`/crashes/${btn.dataset.crash}`);
  if (!r.ok) return toast(r.error, true);
  const c = r.crash;
  // 复用日志下载那套:崩溃现场动辄几百行,塞进 alert 没法看,直接给一个可另存的窗口
  const head = `崩溃时间: ${new Date(c.at).toLocaleString()}\n`
    + `退出码: ${c.exitCode === null ? '—' : c.exitCode}${c.signal ? `  信号: ${c.signal}` : ''}\n`
    + `服务端崩溃报告: ${c.report || '无'}\n${'─'.repeat(60)}\n`;
  const body = `【面板日志 tail】\n${(c.tail || []).join('\n')}\n\n`
    + (c.reportText ? `${'─'.repeat(60)}\n【${c.report}】\n${c.reportText}` : '');
  const w = window.open('', '_blank');
  if (!w) return toast('浏览器拦截了弹窗,无法显示崩溃详情', true);
  w.document.title = `崩溃现场 ${new Date(c.at).toLocaleString()}`;
  const pre = w.document.createElement('pre');
  pre.style.cssText = 'white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,monospace;padding:16px';
  pre.textContent = head + body;      // textContent 而不是 innerHTML:日志里什么都可能有
  w.document.body.style.cssText = 'margin:0;background:#14161a;color:#dfe3ea';
  w.document.body.appendChild(pre);
});

$('#crash-clear').addEventListener('click', async () => {
  if (!confirm('清空这个实例的所有崩溃记录?')) return;
  await iapi('/crashes', { method: 'DELETE' });
  toast('崩溃记录已清空');
  loadCrashes();
});

/* ───────── RCON ───────── */

async function loadRcon() {
  const r = await iapi('/rcon');
  const badge = $('#rcon-status');
  badge.textContent = r.enabled ? '已启用' : '未启用';
  badge.className = `task-badge ${r.enabled ? 'on' : 'off'}`;
  $('#rcon-port').value = r.port || '——';
  $('#rcon-pass').value = r.password || '——';
  $('#rcon-enable').textContent = r.enabled ? '重新生成配置' : '一键开启';
}

$('#rcon-enable').addEventListener('click', async () => {
  const r = await iapi('/rcon/enable', { method: 'POST' });
  if (!r.ok) return toast(r.error, true);
  toast(r.needRestart ? `RCON 已配置(端口 ${r.port}),重启实例后生效` : `RCON 已开启,端口 ${r.port}`);
  loadRcon();
});

$('#backup-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-bact]');
  if (!btn) return;
  if (btn.dataset.bact === 'download') {
    // 备份可能有好几 GB,交给浏览器自己下载,不要走 fetch 攒 blob
    const a = document.createElement('a');
    a.href = `/api/instances/${currentIid}/backups/${encodeURIComponent(btn.dataset.id)}/download`;
    a.download = btn.dataset.id;
    a.click();
    toast('已开始下载');
  } else if (btn.dataset.bact === 'restore') {
    // 恢复是覆盖式的、不可撤销,而备份名只有个时间戳 —— 先把包里有什么、
    // 会盖掉什么摊开给用户看。顺带验一遍归档没坏(坏包在这一步就拦下)
    const p = await iapi(`/backups/${btn.dataset.id}/inspect`);
    if (!p.ok) return toast(p.error, true);
    if (p.chainError) return toast(p.chainError, true);
    const lines = [
      `备份 ${btn.dataset.id}`,
      ...(p.type === 'inc' && p.chain && p.chain.length > 1
        ? [`这是增量备份,将按顺序应用 ${p.chain.length} 个归档:`,
           ...p.chain.map((c, i) => `  ${i + 1}. ${c}`), '']
        : []),
      `包含 ${p.fileCount} 个文件` + (p.worlds.length ? `,世界:${p.worlds.join('、')}` : ',未发现世界存档'),
      p.hasPlugins ? '含插件/模组目录' : '不含插件/模组目录',
      p.hasProps ? '含 server.properties' : '不含 server.properties',
      '',
      p.overwrite.length
        ? `以下现有内容会被覆盖(不可撤销):\n  ${p.overwrite.join('\n  ')}`
        : '当前实例目录为空,不会覆盖任何东西。',
      '',
      // 全量和增量在"删除"这件事上行为不同,不能用同一句话糊过去:
      // 增量链带着目录清单,tar --incremental 会把当时删掉的文件真的删掉
      p.type === 'inc'
        ? '注意:增量恢复会重放删除操作 —— 备份时点已删除的文件会从实例目录中移除。'
        : '注意:恢复只做覆盖,不会删除备份里没有的文件。',
      '确定恢复吗?',
    ];
    if (!confirm(lines.join('\n'))) return;
    const r = await iapi(`/backups/${btn.dataset.id}/restore`, { method: 'POST' });
    r.ok ? toast('备份恢复完成') : toast(r.error, true);
  } else {
    await iapi(`/backups/${btn.dataset.id}`, { method: 'DELETE' });
    toast('备份已删除');
    loadBackups();
  }
});

/* ───────── settings ───────── */

const PROP_ENUMS = {
  gamemode: ['survival', 'creative', 'adventure', 'spectator'],
  difficulty: ['peaceful', 'easy', 'normal', 'hard'],
};
const BOOL_PROPS = new Set(['pvp', 'online-mode', 'white-list', 'allow-nether', 'allow-flight', 'enable-command-block', 'hardcore']);

async function loadProperties() {
  const [props, status] = await Promise.all([iapi('/properties'), iapi('/status')]);
  instMap.set(status.id, status);
  $('#cfg-name').value = status.name || '';
  $('#cfg-icon').value = status.icon || '🌳';
  $('#cfg-xmx').value = status.xmx || 2048;
  $('#cfg-jvm').value = status.jvmArgs || '';
  loadReinstall(status);
  loadConfigs();
  loadServerIcon();
  renderCollab(status);
  $('#cfg-autorestart').checked = status.autoRestart !== false;
  $('#cfg-autostart').checked = status.autoStart !== false;
  $('#cfg-ygg-on').checked = !!(status.yggdrasil && status.yggdrasil.enabled);
  $('#cfg-ygg-url').value = (status.yggdrasil && status.yggdrasil.url) || '';
  $('#props-grid').innerHTML = Object.entries(props).map(([k, v]) => {
    let field;
    if (PROP_ENUMS[k]) {
      field = `<select data-prop="${k}">${PROP_ENUMS[k].map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    } else if (BOOL_PROPS.has(k) || v === 'true' || v === 'false') {
      field = `<label class="switch prop-switch"><input type="checkbox" data-prop="${k}" ${v === 'true' ? 'checked' : ''}><span class="slider"></span></label>`;
    } else {
      field = `<input data-prop="${k}" value="${escapeHtml(v)}">`;
    }
    return `<div class="prop-row"><label>${k}</label>${field}</div>`;
  }).join('');
}

$('#inst-cfg-save').addEventListener('click', async () => {
  const mb = parseInt($('#cfg-xmx').value, 10);
  if (!mb || mb < 512 || mb > 65536) return toast('内存上限需在 512 ~ 65536 MB 之间', true);
  const yggEnabled = $('#cfg-ygg-on').checked;
  const yggUrl = $('#cfg-ygg-url').value.trim();
  if (yggEnabled && !/^https?:\/\/.+/.test(yggUrl)) return toast('启用外置登录需填写 Yggdrasil API 地址(http(s) URL)', true);
  const btn = $('#inst-cfg-save');
  btn.disabled = true;
  const name = $('#cfg-name').value.trim();
  if (!name) return toast('实例名称不能为空', true);
  const r = await iapi('', { method: 'PATCH', body: { name, icon: $('#cfg-icon').value, xmx: mb, jvmArgs: $('#cfg-jvm').value, autoRestart: $('#cfg-autorestart').checked, autoStart: $('#cfg-autostart').checked, yggdrasil: { enabled: yggEnabled, url: yggUrl } } });
  btn.disabled = false;
  if (r.ok) {
    instMap.set(r.instance.id, r.instance);
    toast('实例配置已保存' + (r.instance.state === 'running' ? ',重启后生效' : ''));
  } else toast(r.error, true);
});

/* 开关类属性:每次拨动立即保存该项(失败回滚);文本/数字仍走「保存更改」 */
$('#props-grid').addEventListener('change', async (e) => {
  const el = e.target;
  if (el.type !== 'checkbox' || !el.dataset.prop) return;
  el.disabled = true;
  const r = await iapi('/properties', { method: 'PUT', body: { [el.dataset.prop]: String(el.checked) } });
  el.disabled = false;
  if (r.ok) {
    const inst = instMap.get(currentIid);
    toast(`${el.dataset.prop} 已${el.checked ? '开启' : '关闭'}` + (inst && inst.state === 'running' ? '(重启后生效)' : ''));
  } else {
    el.checked = !el.checked;
    toast(r.error || '保存失败', true);
  }
});

$('#props-save').addEventListener('click', async () => {
  const updates = {};
  $$('#props-grid [data-prop]').forEach((el) => { updates[el.dataset.prop] = el.type === 'checkbox' ? String(el.checked) : el.value; });
  const r = await iapi('/properties', { method: 'PUT', body: updates });
  if (r.ok) {
    const inst = instMap.get(currentIid);
    toast('配置已保存' + (inst && inst.state === 'running' ? ',重启后生效' : ''));
  }
});

/* ───────── users (admin) ───────── */

/* OAuth 配置卡片(管理员) */
async function loadOauthConfig() {
  const c = await api('/oauth/config');
  $('#og-status').textContent = c.enabled ? '已启用' : '未启用';
  $('#og-status').style.color = c.enabled ? 'var(--green)' : '';
  $('#og-name').value = c.providerName || '';
  $('#og-cid').value = c.clientId || '';
  $('#og-csec').value = c.clientSecret || '';
  $('#og-scope').value = c.scope || '';
  $('#og-auth').value = c.authUrl || '';
  $('#og-token').value = c.tokenUrl || '';
  $('#og-info').value = c.userInfoUrl || '';
  $('#og-redirect').value = c.redirectUri || '';
  $('#og-autocreate').checked = !!c.autoCreate;
  const dl = c.defaultLimits || {};
  $('#og-lim-inst').value = dl.maxInstances || 1;
  $('#og-lim-mem').value = dl.maxMemMB || 2048;
  $('#og-lim-cpu').value = dl.maxCpuCores || 2;
  $('#og-lim-disk').value = dl.maxDiskMB ?? 20480;
}

$('#og-save').addEventListener('click', async () => {
  const r = await api('/oauth/config', {
    method: 'PUT',
    body: {
      providerName: $('#og-name').value, clientId: $('#og-cid').value, clientSecret: $('#og-csec').value,
      scope: $('#og-scope').value, authUrl: $('#og-auth').value, tokenUrl: $('#og-token').value,
      userInfoUrl: $('#og-info').value, redirectUri: $('#og-redirect').value,
      autoCreate: $('#og-autocreate').checked,
      defaultLimits: {
        maxInstances: $('#og-lim-inst').value,
        maxMemMB: $('#og-lim-mem').value,
        maxCpuCores: $('#og-lim-cpu').value,
        maxDiskMB: $('#og-lim-disk').value,
      },
    },
  });
  if (r.ok) { toast(r.enabled ? 'OAuth 已启用' : '已保存(配置不完整,未启用)'); loadOauthConfig(); }
  else toast(r.error, true);
});

let userPage = 1;
const USER_PAGE_SIZE = 10;

/* ── 邀请链接 ── */

const INV_STATUS = { live: ['可用', 'on'], used: ['已使用', 'off'], expired: ['已过期', 'off'] };

async function loadInvites() {
  const r = await api('/users/invites/list');
  const rows = r.invites || [];
  $('#invite-list').innerHTML = rows.length ? rows.map((i) => {
    const [label, cls] = INV_STATUS[i.status] || INV_STATUS.expired;
    const url = `${location.origin}/invite/${i.token}`;
    return `
      <div class="backup-item">
        <div>
          <div class="backup-name">
            <span class="task-badge ${cls}">${label}</span>
            ${i.note ? escapeHtml(i.note) : '<span class="dim">无备注</span>'}
          </div>
          <div class="backup-meta">
            ${i.createdBy} 创建于 ${fmtAgo(i.createdAt)}
            · ${i.expiresAt ? `到期 ${new Date(i.expiresAt).toLocaleString()}` : '永不过期'}
            ${i.usedBy ? `· 已被 <b>${escapeHtml(i.usedBy)}</b> 使用` : ''}
          </div>
        </div>
        <div class="spacer"></div>
        ${i.status === 'live' ? `<button class="icon-btn" data-invcopy="${url}">复制链接</button>` : ''}
        <button class="icon-btn danger" data-invdel="${i.token}">删除</button>
      </div>`;
  }).join('') : '<div class="empty">还没有邀请链接</div>';
}

$('#inv-create').addEventListener('click', async () => {
  const r = await api('/users/invites', {
    method: 'POST',
    body: {
      note: $('#inv-note').value,
      expiresInHours: $('#inv-hours').value === '' ? 168 : parseInt($('#inv-hours').value, 10),
      limits: {
        maxInstances: $('#inv-lim-inst').value, maxMemMB: $('#inv-lim-mem').value,
        maxCpuCores: $('#inv-lim-cpu').value, maxDiskMB: $('#inv-lim-disk').value,
      },
    },
  });
  if (!r.ok) return toast(r.error, true);
  const url = `${location.origin}/invite/${r.token}`;
  await copyText(url);
  toast('邀请链接已生成并复制到剪贴板');
  ['inv-note', 'inv-hours'].forEach((id) => { $('#' + id).value = ''; });
  loadInvites();
});

$('#invite-list').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-invcopy]');
  if (copy) { await copyText(copy.dataset.invcopy); return toast('已复制'); }
  const del = e.target.closest('[data-invdel]');
  if (!del) return;
  if (!confirm('删除这条邀请记录?已使用的记录删掉后就查不到是谁邀请的了。')) return;
  await api(`/users/invites/${del.dataset.invdel}`, { method: 'DELETE' });
  loadInvites();
});

async function loadUsers() {
  loadInvites();
  const list = await api('/users');
  const pages = Math.max(1, Math.ceil(list.length / USER_PAGE_SIZE));
  if (userPage > pages) userPage = pages;
  const slice = list.slice((userPage - 1) * USER_PAGE_SIZE, userPage * USER_PAGE_SIZE);
  $('#user-count').textContent = `共 ${list.length} 个`;
  $('#user-pager').hidden = pages <= 1;
  if (pages > 1) {
    $('#user-pager-info').textContent = `第 ${userPage} / ${pages} 页`;
    $('#user-pager [data-upage="prev"]').disabled = userPage <= 1;
    $('#user-pager [data-upage="next"]').disabled = userPage >= pages;
  }
  $('#user-list').innerHTML = slice.map((u) => `
    <div class="backup-item">
      <div class="avatar" style="background:${avatarColor(u.username)}">${u.username[0].toUpperCase()}</div>
      <div>
        <div class="backup-name">${escapeHtml(u.username)}
          <span class="task-badge ${u.role === 'admin' ? '' : 'off'}">${u.role === 'admin' ? '管理员' : '普通用户'}</span>
          ${u.oauth ? `<span class="task-badge off" style="color:#8ec5ff">OAuth${u.oauthName ? ' · ' + escapeHtml(u.oauthName) : ''}</span>` : ''}
          ${u.defaultPassword ? '<span class="task-badge off" style="color:#ffe479;border-color:rgba(255,214,10,0.4)">默认密码未修改</span>' : ''}
        </div>
        <div class="backup-meta">${u.limits
          ? `实例 ${u.usage.instances}/${u.limits.maxInstances} · 内存 <span title="${u.usage.memMB} MB 堆(-Xmx 之和)+ ${(u.usage.memReservedMB || u.usage.memMB) - u.usage.memMB} MB 堆外余量。配额按含堆外的实际预留计">${u.usage.memReservedMB || u.usage.memMB}/${u.limits.maxMemMB} MB</span> · CPU ${u.limits.maxCpuCores} 核 · 磁盘 ${u.usage.diskMB}/${u.limits.maxDiskMB || '∞'} MB · `
          : `实例 ${u.usage.instances} · 不受配额限制 · `}创建于 ${fmtAgo(u.createdAt)}</div>
      </div>
      <div class="spacer"></div>
      ${u.limits ? `<button class="icon-btn" data-uact="limits" data-name="${u.username}"
        data-limits='${JSON.stringify(u.limits)}'>配额</button>` : ''}
      <button class="icon-btn" data-uact="passwd" data-name="${u.username}">重置密码</button>
      ${u.username !== me.username ? `<button class="icon-btn danger" data-uact="del" data-name="${u.username}">删除</button>` : ''}
    </div>`).join('');
}

$('#user-pager').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-upage]');
  if (!btn || btn.disabled) return;
  userPage += btn.dataset.upage === 'next' ? 1 : -1;
  loadUsers();
});

$('#user-role').addEventListener('change', () => {
  $('#user-limits-row').style.display = $('#user-role').value === 'admin' ? 'none' : '';
});

$('#user-create').addEventListener('click', async () => {
  const r = await api('/users', {
    method: 'POST',
    body: {
      username: $('#user-name').value.trim(), password: $('#user-pass').value, role: $('#user-role').value,
      limits: {
        maxInstances: $('#user-lim-inst').value,
        maxMemMB: $('#user-lim-mem').value,
        maxCpuCores: $('#user-lim-cpu').value,
        maxDiskMB: $('#user-lim-disk').value,
      },
    },
  });
  if (r.ok) {
    ['user-name', 'user-pass', 'user-lim-inst', 'user-lim-mem', 'user-lim-cpu', 'user-lim-disk'].forEach((id) => { $('#' + id).value = ''; });
    toast('用户已创建');
    loadUsers();
  } else toast(r.error, true);
});

/* 配额编辑弹窗 */
let limitsTarget = null;
$('#lim-cancel').addEventListener('click', () => { $('#limits-modal').hidden = true; });
$('#lim-ok').addEventListener('click', async () => {
  const r = await api(`/users/${encodeURIComponent(limitsTarget)}/limits`, {
    method: 'PUT',
    body: {
      maxInstances: $('#lim-inst').value, maxMemMB: $('#lim-mem').value,
      maxCpuCores: $('#lim-cpu').value, maxDiskMB: $('#lim-disk').value,
    },
  });
  if (r.ok) { $('#limits-modal').hidden = true; toast('配额已更新'); loadUsers(); }
  else toast(r.error, true);
});

$('#user-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-uact]');
  if (!btn) return;
  const { uact, name } = btn.dataset;
  if (uact === 'limits') {
    limitsTarget = name;
    const lim = JSON.parse(btn.dataset.limits);
    $('#limits-user').textContent = name;
    $('#lim-inst').value = lim.maxInstances;
    $('#lim-mem').value = lim.maxMemMB;
    $('#lim-cpu').value = lim.maxCpuCores;
    $('#lim-disk').value = lim.maxDiskMB ?? 20480;
    $('#limits-modal').hidden = false;
  } else if (uact === 'del') {
    if (!confirm(`删除用户 ${name} ?`)) return;
    const r = await api(`/users/${encodeURIComponent(name)}`, { method: 'DELETE' });
    r.ok ? (toast('用户已删除'), loadUsers()) : toast(r.error, true);
  } else if (uact === 'passwd') {
    const pw = prompt(`为 ${name} 设置新密码(至少 6 位):`);
    if (!pw) return;
    const r = await api(`/users/${encodeURIComponent(name)}/password`, { method: 'PUT', body: { password: pw } });
    r.ok ? toast('密码已重置') : toast(r.error, true);
  }
});

/* ───────── system settings & announcement (admin) ───────── */

const NOTIFY_EVENTS = {
  crash: '实例异常退出',
  restartBlocked: '重启风暴保护触发',
  backupFailed: '备份失败',
  taskFailed: '计划任务连续失败',
  diskLow: '磁盘空间不足(≥90%)',
};

function notifyBody() {
  const events = {};
  $$('#nt-events [data-nev]').forEach((c) => { events[c.dataset.nev] = c.checked; });
  return {
    enabled: $('#nt-enabled').checked,
    webhookUrl: $('#nt-webhook').value.trim(),
    discordUrl: $('#nt-discord').value.trim(),
    telegramToken: $('#nt-tgtoken').value.trim(),
    telegramChatId: $('#nt-tgchat').value.trim(),
    events,
  };
}

function renderNotify(n) {
  n = n || {};
  $('#nt-enabled').checked = !!n.enabled;
  $('#nt-webhook').value = n.webhookUrl || '';
  $('#nt-discord').value = n.discordUrl || '';
  $('#nt-tgtoken').value = n.telegramToken || '';
  $('#nt-tgchat').value = n.telegramChatId || '';
  const ev = n.events || {};
  $('#nt-events').innerHTML = Object.entries(NOTIFY_EVENTS).map(([k, label]) => `
    <div class="prop-row"><label>${label}</label>
      <label class="switch prop-switch"><input type="checkbox" data-nev="${k}" ${ev[k] !== false ? 'checked' : ''}><span class="slider"></span></label>
    </div>`).join('');
  const badge = $('#nt-status');
  badge.textContent = n.enabled ? '已启用' : '未启用';
  badge.className = `task-badge ${n.enabled ? '' : 'off'}`;
}

checkVersion(false);

$('#nt-save').addEventListener('click', async () => {
  const r = await api('/settings', { method: 'PUT', body: { notify: notifyBody() } });
  if (r.ok) { renderNotify(r.settings.notify); toast('告警配置已保存'); }
  else toast(r.error, true);
});

$('#nt-test').addEventListener('click', async () => {
  const btn = $('#nt-test');
  btn.disabled = true;
  $('#nt-result').textContent = '正在发送…';
  const r = await api('/settings/notify/test', { method: 'POST', body: { notify: notifyBody() } });
  btn.disabled = false;
  const results = (r && r.results) || [];
  $('#nt-result').innerHTML = results.map((x) =>
    `<span class="${x.ok ? 'task-result ok' : 'task-result bad'}">${x.ok ? '✔' : '✘'} ${escapeHtml(x.name)}${x.ok ? '' : ': ' + escapeHtml(x.error || '')}</span>`).join(' &nbsp; ')
    || '没有配置任何推送目标';
});

async function loadAudit() {
  const q = $('#au-q').value.trim();
  const d = await api(`/audit?limit=100${q ? '&q=' + encodeURIComponent(q) : ''}`);
  const rows = (d && d.rows) || [];
  $('#audit-list').innerHTML = rows.length ? rows.map((r) => {
    const bad = r.status >= 400;
    const params = r.params && Object.keys(r.params).length
      ? escapeHtml(JSON.stringify(r.params)).slice(0, 160) : '';
    return `<div class="audit-row ${bad ? 'bad' : ''}">
      <div class="au-time dim small">${new Date(r.at).toLocaleString('zh-CN')}</div>
      <div class="au-user">${escapeHtml(r.user)}</div>
      <div class="au-action">${escapeHtml(r.action)}</div>
      <div class="au-status ${bad ? 'bad' : 'ok'}">${r.status}</div>
      <div class="au-detail dim small" title="${escapeHtml(r.path)}">${escapeHtml(r.path)}${params ? ' · ' + params : ''}</div>
    </div>`;
  }).join('') : '<div class="empty">暂无审计记录</div>';
  // total 是"最近这段扫描窗口内"的命中数;truncated 说明更早的还没翻,别说成总数
  if (d && d.total > rows.length) {
    const scope = d.truncated ? '较近的记录中至少有' : '共';
    $('#audit-list').insertAdjacentHTML('beforeend',
      `<div class="dim small" style="padding:8px 4px">${scope} ${d.total} 条,只显示最近 ${rows.length} 条</div>`);
  }
}
$('#au-refresh').addEventListener('click', loadAudit);
$('#au-q').addEventListener('input', (() => {
  let t = null;
  return () => { clearTimeout(t); t = setTimeout(loadAudit, 300); };
})());

async function loadSystem() {
  loadOauthConfig();   // OAuth 第三方登录配置卡片在本视图内
  const s = await api('/settings');
  $('#sys-reg').checked = !!s.registrationEnabled;
  $('#sys-bk-count').value = s.backupKeepCount ?? 10;
  $('#sys-bk-days').value = s.backupKeepDays ?? 30;
  $('#sys-announcement').value = s.announcement || '';
  $('#sys-2fa').checked = !!s.require2FA;
  render2faPolicy(!!s.require2FA);
  const t = s.thresholds || {};
  $('#sys-disk-pct').value = t.diskWarnPct ?? 90;
  $('#sys-crash-win').value = t.crashWindowMin ?? 10;
  $('#sys-crash-max').value = t.crashMaxRestarts ?? 3;
  $('#sys-crash-delay').value = t.crashRestartDelaySec ?? 5;
  $('#sys-mem-pct').value = t.memOverheadPct ?? 13;
  $('#sys-mem-min').value = t.memOverheadMinMB ?? 512;
  renderRemoteBackup(s.backupRemote);
  renderNotify(s.notify);
  loadAudit();
}

/* ── 异地备份 ── */

function renderRemoteBackup(r) {
  r = r || {};
  $('#rb-enabled').checked = !!r.enabled;
  $('#rb-type').value = r.type || 's3';
  $('#rb-prefix').value = r.prefix || '';
  $('#rb-endpoint').value = r.endpoint || '';
  $('#rb-bucket').value = r.bucket || '';
  $('#rb-region').value = r.region || 'us-east-1';
  $('#rb-ak').value = r.accessKey || '';
  $('#rb-sk').value = r.secretKey || '';        // 已保存时后端给的是掩码
  $('#rb-pathstyle').checked = r.pathStyle !== false;
  $('#rb-url').value = r.url || '';
  $('#rb-user').value = r.username || '';
  $('#rb-pass').value = r.password || '';
  const badge = $('#rb-status');
  badge.textContent = r.enabled ? `已启用 · ${r.type}` : '未启用';
  badge.className = `task-badge ${r.enabled ? 'on' : 'off'}`;
  $('#rb-remote').value = r.remote || '';
  $('#rb-path').value = r.path || '';
  syncRemoteFields();
}

/** 只显示当前类型那组字段 —— 三组堆在一起没人分得清哪个该填 */
function syncRemoteFields() {
  const t = $('#rb-type').value;
  $$('.rb-fields').forEach((el) => { el.hidden = el.dataset.rb !== t; });
}
$('#rb-type').addEventListener('change', syncRemoteFields);

function remoteBody() {
  return {
    backupRemote: {
      enabled: $('#rb-enabled').checked,
      type: $('#rb-type').value,
      prefix: $('#rb-prefix').value,
      endpoint: $('#rb-endpoint').value,
      bucket: $('#rb-bucket').value,
      region: $('#rb-region').value,
      accessKey: $('#rb-ak').value,
      secretKey: $('#rb-sk').value,     // 掩码原样回传 = 不修改,后端认这个
      pathStyle: $('#rb-pathstyle').checked,
      url: $('#rb-url').value,
      username: $('#rb-user').value,
      password: $('#rb-pass').value,
      remote: $('#rb-remote').value,
      path: $('#rb-path').value,
    },
  };
}

$('#rb-save').addEventListener('click', async () => {
  const r = await api('/settings', { method: 'PUT', body: remoteBody() });
  if (!r.ok) return toast(r.error, true);
  toast('异地备份配置已保存');
  renderRemoteBackup(r.settings.backupRemote);
});

$('#rb-test').addEventListener('click', async () => {
  // 用已保存的配置测,所以先存 —— 否则用户改完没点保存就点测试,测的是旧配置
  const s = await api('/settings', { method: 'PUT', body: remoteBody() });
  if (!s.ok) return toast(s.error, true);
  renderRemoteBackup(s.settings.backupRemote);
  toast('正在测试…');
  const r = await api('/settings/backup-remote/test', { method: 'POST' });
  if (r.ok) alert(`连通性正常。\n\n${r.note || ''}`);
  else alert(`连接失败:\n\n${r.error}`);
});

/**
 * 强制 2FA 开关的可用性。后端已经硬拦了(没配 TOTP 就返回 400),
 * 这里只是别让用户白点一次 —— 直接把开关禁掉并说清楚为什么。
 * 策略已经开着时不禁用:那时关闭是逃生方向,永远要留着。
 */
function render2faPolicy(enabled) {
  const box = $('#sys-2fa');
  const hint = $('#sys-2fa-hint');
  const blocked = !enabled && me && !me.twoFactor;
  box.disabled = blocked;
  if (blocked) box.checked = false;
  hint.hidden = !blocked;
}

$('#sys-save').addEventListener('click', async () => {
  const r = await api('/settings', {
    method: 'PUT',
    body: {
      registrationEnabled: $('#sys-reg').checked,
      require2FA: $('#sys-2fa').checked,
      announcement: $('#sys-announcement').value,
      backupKeepCount: parseInt($('#sys-bk-count').value, 10) || 0,
      backupKeepDays: parseInt($('#sys-bk-days').value, 10) || 0,
      thresholds: {
        diskWarnPct: parseInt($('#sys-disk-pct').value, 10),
        crashWindowMin: parseInt($('#sys-crash-win').value, 10),
        crashMaxRestarts: parseInt($('#sys-crash-max').value, 10),
        crashRestartDelaySec: parseInt($('#sys-crash-delay').value, 10),
        memOverheadPct: parseInt($('#sys-mem-pct').value, 10),
        memOverheadMinMB: parseInt($('#sys-mem-min').value, 10),
      },
    },
  });
  if (r.ok) { toast('系统设置已保存'); renderAnnouncement(r.settings); loadSystem(); }
  else toast(r.error, true);
});

/* ── 面板配置备份 ── */

$('#pb-export').addEventListener('click', () => {
  // 走 <a download> 而不是 fetch:响应带 Content-Disposition,交给浏览器直接落盘
  const a = document.createElement('a');
  a.href = '/api/panel/export';
  a.download = '';
  a.click();
  toast('导出文件含口令哈希与 Token 摘要,请妥善保管');
});

$('#pb-import').addEventListener('click', () => $('#pb-file').click());

$('#pb-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';        // 选同一个文件两次也要能触发
  if (!file) return;
  let bundle;
  try {
    bundle = JSON.parse(await file.text());
  } catch (err) {
    return toast(`不是合法的 JSON 文件: ${err.message}`, true);
  }
  // 先干跑:让用户看清楚要盖掉什么再决定,而不是点完才知道
  const pre = await api('/panel/import/preview', { method: 'POST', body: { bundle } });
  if (!pre.ok) return toast(pre.error, true);
  const s = pre.summary;
  const when = pre.exportedAt ? new Date(pre.exportedAt).toLocaleString() : '未知时间';
  if (!confirm(`这个备份导出于 ${when}(面板 v${pre.panelVersion || '?'}),包含:\n`
    + `  用户 ${s.users} 个(管理员 ${s.admins})\n  实例元数据 ${s.instances} 条\n  计划任务 ${s.tasks} 条\n\n`
    + `将覆盖 ${s.files.join('、')}。\n现有文件会另存为 .bak-<时间戳>,导入后需要重启面板。\n\n确定导入吗?`)) return;
  const r = await api('/panel/import', { method: 'POST', body: { bundle } });
  if (r.ok) alert(`导入完成:${r.restored.join('、')}\n\n${r.note}`);
  else toast(r.error, true);
});

/* 公告横幅:按「内容+发布时间」记忆关闭状态,公告更新后重新弹出 */
function renderAnnouncement(s) {
  const bar = $('#announce-bar');
  if (!s || !s.announcement) { bar.hidden = true; return; }
  const key = `${s.announcementAt}`;
  if (localStorage.getItem('mcsp_announce_dismissed') === key) { bar.hidden = true; return; }
  $('#announce-text').textContent = s.announcement;
  bar.dataset.key = key;
  bar.hidden = false;
}

$('#announce-close').addEventListener('click', () => {
  localStorage.setItem('mcsp_announce_dismissed', $('#announce-bar').dataset.key || '');
  $('#announce-bar').hidden = true;
});

async function loadAnnouncement() {
  try { renderAnnouncement(await api('/settings')); } catch {}
}

/* ───────── account ───────── */

$('#btn-logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  location.href = '/login';
});

$('#btn-passwd').addEventListener('click', async () => {
  $('#pw-modal').hidden = false;
  $('#pw-old').focus();
  // OAuth 已配置时提供绑定入口(把第三方身份挂到当前账号)
  try {
    const s = await fetch('/api/auth/oauth/status').then((r) => r.json());
    if (s.enabled) {
      $('#oauth-bind-btn').textContent = `绑定 ${s.name} 账号`;
      $('#oauth-bind-row').hidden = false;
    }
  } catch {}
});
$('#oauth-bind-btn').addEventListener('click', () => { location.href = '/api/auth/oauth/bind'; });
$('#pw-cancel').addEventListener('click', () => { $('#pw-modal').hidden = true; });
$('#pw-ok').addEventListener('click', async () => {
  if ($('#pw-new').value !== $('#pw-new2').value) return toast('两次输入的新密码不一致', true);
  const r = await api('/auth/password', {
    method: 'PUT',
    body: { oldPassword: $('#pw-old').value, newPassword: $('#pw-new').value },
  });
  if (r.ok) {
    $('#pw-modal').hidden = true;
    $('#pw-old').value = $('#pw-new').value = $('#pw-new2').value = '';
    toast('密码已修改');
  } else toast(r.error, true);
});

for (const id of ['#pw-modal', '#inst-modal']) {
  $(id).addEventListener('click', (e) => { if (e.target === $(id)) $(id).hidden = true; });
}

/* ───────── appearance ───────── */

const AP_DEFAULT = { theme: 'dark', style: 'pixel', accent: '10, 132, 255', bg: 'aurora', density: 'comfortable' };
let appearance = { ...AP_DEFAULT, ...(JSON.parse(localStorage.getItem('mcsp_appearance') || '{}')) };

function applyAppearance() {
  const root = document.documentElement;
  let theme = appearance.theme;
  if (theme === 'auto') theme = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  root.dataset.theme = theme;
  root.dataset.style = appearance.style;
  root.dataset.bg = appearance.bg;
  root.dataset.density = appearance.density;
  root.style.setProperty('--acc-rgb', appearance.accent);
  localStorage.setItem('mcsp_appearance', JSON.stringify(appearance));
  // sync modal控件高亮
  for (const [group, key] of [['#ap-style', 'style'], ['#ap-theme', 'theme'], ['#ap-bg', 'bg'], ['#ap-density', 'density']]) {
    $$(group + ' .seg').forEach((b) => b.classList.toggle('active', b.dataset.val === appearance[key]));
  }
  $$('#ap-accent .swatch').forEach((b) => b.classList.toggle('active', b.dataset.val === appearance.accent));
  drawChart();
}

matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (appearance.theme === 'auto') applyAppearance();
});

/* ───────── 弹窗通用行为 ─────────
   四个弹窗此前只是 .hidden 开关:按 Esc 关不掉,Tab 会走到弹窗背后的页面上,
   关闭后焦点掉回 <body>。这些都是键盘和读屏用户绕不过去的。
   四个弹窗开关点散落在各处,所以用 MutationObserver 兜住每条路径,
   而不是去十来个调用点各补一遍(将来新增弹窗也自动生效)。 */
(function modalBehaviour() {
  const masks = $$('.modal-mask');
  if (!masks.length) return;
  let lastOutsideFocus = null;

  const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  const focusables = (m) => [...m.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  const openMask = () => masks.filter((m) => !m.hidden).pop();

  // 记住弹窗外最后一个获得焦点的元素,关闭时好还回去
  document.addEventListener('focusin', (e) => {
    if (!e.target.closest || !e.target.closest('.modal-mask')) lastOutsideFocus = e.target;
  });

  for (const m of masks) {
    new MutationObserver(() => {
      if (!m.hidden) {
        // 有些调用点自己会 focus 输入框,别抢
        if (!m.contains(document.activeElement)) {
          const f = focusables(m);
          if (f.length) f[0].focus();
        }
      } else if (lastOutsideFocus && document.body.contains(lastOutsideFocus)) {
        lastOutsideFocus.focus();
      }
    }).observe(m, { attributes: true, attributeFilter: ['hidden'] });
  }

  document.addEventListener('keydown', (e) => {
    const open = openMask();
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); open.hidden = true; return; }
    if (e.key !== 'Tab') return;
    const f = focusables(open);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
})();

$('#btn-appearance').addEventListener('click', () => { applyAppearance(); $('#ap-modal').hidden = false; });
$('#ap-close').addEventListener('click', () => { $('#ap-modal').hidden = true; });
$('#ap-reset').addEventListener('click', () => { appearance = { ...AP_DEFAULT }; applyAppearance(); });
$('#ap-modal').addEventListener('click', (e) => { if (e.target === $('#ap-modal')) $('#ap-modal').hidden = true; });

for (const [group, key] of [['#ap-style', 'style'], ['#ap-theme', 'theme'], ['#ap-bg', 'bg'], ['#ap-density', 'density']]) {
  $(group).addEventListener('click', (e) => {
    const b = e.target.closest('.seg');
    if (!b) return;
    appearance[key] = b.dataset.val;
    applyAppearance();
  });
}
$('#ap-accent').addEventListener('click', (e) => {
  const b = e.target.closest('.swatch');
  if (!b) return;
  appearance.accent = b.dataset.val;
  applyAppearance();
});

/* ───────── SSE stream ───────── */

function connectStream() {
  const es = new EventSource('/api/stream');
  es.addEventListener('state', (e) => {
    const s = JSON.parse(e.data);
    instMap.set(s.id, s);
    if (s.id === currentIid) applyTopbar();
    if (currentView === 'overview') renderInstGrid();
    if (currentView === 'tunnel' && s.id === currentIid && s.tunnel) applyTunnelStatus(s.tunnel);
    renderInstSelect();
  });
  es.addEventListener('components', (e) => {
    if (currentView === 'tunnel') renderTunnelComponents(JSON.parse(e.data));
  });
  es.addEventListener('java', (e) => {
    if (currentView !== 'overview') return;
    const j = JSON.parse(e.data);
    const cell = $('#java-cell');
    const cur = j.majors.find((m) => m.installing);
    if (cur && cell) cell.innerHTML = `<span class="dim small">下载 Java ${cur.major} … ${cur.progress}%</span>`;
    else loadOverview();   // 单个版本装完/全部完成:重新拉取完整状态
  });
  es.addEventListener('log', (e) => {
    const d = JSON.parse(e.data);
    if (d.iid === currentIid) appendLog(d);
  });
  es.addEventListener('metrics', (e) => {
    const p = JSON.parse(e.data);
    if (p.iid !== currentIid) return;
    metricsHistory.push(p);
    if (metricsHistory.length > 150) metricsHistory.shift();
    const inst = instMap.get(currentIid);
    if (inst) {
      inst.metrics = { ...inst.metrics, cpu: p.cpu, ram: p.ram };
      applyDashboardStats(inst);
    }
    if (currentView === 'dashboard' && chartRange === 'live') drawChart();
  });
  es.addEventListener('players', (e) => {
    const d = JSON.parse(e.data);
    if (d.iid === currentIid && currentView === 'players') loadPlayers();
  });
  es.addEventListener('instances', () => {
    if (currentView === 'overview') loadOverview();
  });
  es.addEventListener('tasks', (e) => {
    if (currentView === 'tasks' && JSON.parse(e.data).iid === currentIid) loadTasks();
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectStream, 3000);
  };
}

/* ───────── init ───────── */

(async function init() {
  const meRes = await api('/auth/me');
  me = meRes.user;
  // 老服务端不带这块,兜底到内置默认值,别让上传直接不可用
  uploadCfg = meRes.upload || null;
  uploadGate = makeLimiter((uploadCfg && uploadCfg.concurrency) || 3);
  $('#me-name').textContent = me.username;
  $('#me-role').textContent = me.role === 'admin' ? '管理员' : '普通用户';
  $('#me-avatar').textContent = me.username[0].toUpperCase();
  $('#me-avatar').style.background = avatarColor(me.username);
  if (me.role === 'admin') $$('.admin-only').forEach((el) => { el.hidden = false; });
  if (me.defaultPassword) toast('你仍在使用默认密码,请点击侧栏 🔑 尽快修改', true);

  // 强制 2FA 且自己还没配:后面每个接口都会 403,继续初始化只会得到一个空白面板。
  // 直接停在账号安全页,那里的 /auth/* 接口是唯一放行的
  if (me.require2FA && !me.twoFactor && !me.viaToken) {
    switchView('account');
    force2FA('管理员已要求所有账号启用两步验证,请先在此完成配置');
    return;
  }

  const list = await api('/instances');
  instMap = new Map(list.map((i) => [i.id, i]));
  renderInstSelect();          // 顺带把失效的 currentIid 归位
  if (currentIid) await refreshInstanceContext();
  switchView('overview');
  connectStream();
  loadAnnouncement();
})();
