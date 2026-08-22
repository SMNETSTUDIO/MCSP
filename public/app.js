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
};

const TUNNEL_STATE_TEXT = {
  stopped: ['未启动', 'pill-gray'],
  starting: ['连接中…', 'pill-amber'],
  running: ['已建立', 'pill-green'],
};

const STATE_TEXT = {
  stopped: ['已停止', 'pill-gray'],
  installing: ['安装中…', 'pill-amber'],
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

/* ───────── helpers ───────── */

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) { location.href = '/login'; throw new Error('unauthorized'); }
  return res.json();
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

/* ───────── navigation ───────── */

function switchView(view) {
  const instViews = !['overview', 'users', 'system'].includes(view);
  if (instViews && !currentIid) {
    toast('请先创建一个实例', true);
    view = 'overview';
  }
  currentView = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.remove('active'));
  $('#view-' + view).classList.add('active');
  const [title, sub] = VIEW_TITLES[view];
  $('#view-title').textContent = title;
  const inst = instMap.get(currentIid);
  $('#topbar-sub').textContent = sub || (inst ? `${inst.name} · ${typeLabel(inst.type)} ${inst.version} · 端口 ${inst.port}` : '');
  $('#inst-actions').hidden = ['overview', 'users', 'system'].includes(view);

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
    settings: loadProperties,
    users: loadUsers,
    system: loadSystem,
  };
  (loaders[view] || (() => {}))();
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
  const logs = await iapi('/logs');
  $('#console').innerHTML = '';
  $('#dash-log').innerHTML = '';
  for (const entry of logs) appendLog(entry);
  fmPath = '/'; fmOpenFile = null; $('#fm-editor').hidden = true;
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
  $('#stat-ram').innerHTML = `${inst.metrics.ram} <span class="dim small">/ ${inst.metrics.ramMax} MB</span>`;
  $('#bar-ram').style.width = Math.min(100, (inst.metrics.ram / inst.metrics.ramMax) * 100) + '%';
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
      style="margin-left:8px;padding:3px 10px;font-size:12px">⬇ ${have.length || host.javaVersion ? '补齐全部版本' : '一键安装'}</button>`;
  }
  return text;
}

async function loadOverview() {
  const [host, list] = await Promise.all([api('/host'), api('/instances')]);
  instMap = new Map(list.map((i) => [i.id, i]));
  renderInstSelect();

  $('#host-name').textContent = `${host.hostname} · ${host.platform}`;
  const memPct = Math.round(((host.totalMem - host.freeMem) / host.totalMem) * 100);
  $('#host-grid').innerHTML = [
    ['CPU', `${escapeHtml(host.cpuModel.split(' ').slice(0, 3).join(' '))} <span class="dim small">× ${host.cores}</span>`],
    ['负载', `${host.loadavg.join(' / ')}`],
    ['内存', `${memPct}% <span class="dim small">${Math.round((host.totalMem - host.freeMem) / 1024)} / ${Math.round(host.totalMem / 1024)} GB</span>`],
    ['磁盘', host.disk
      ? `<span class="${host.disk.usedPct >= 90 ? 'disk-warn' : ''}">${host.disk.usedPct}%</span> <span class="dim small">${(host.disk.usedMB / 1024).toFixed(1)} / ${(host.disk.totalMB / 1024).toFixed(1)} GB</span>`
      : '<span class="dim small">不可用</span>'],
    ['面板运行', fmtUptime(host.panelUptime)],
    ['Java', `<span id="java-cell">${javaCellHtml(host)}</span>`],
    ['Node', host.nodeVersion],
    ['实例', `${host.runningCount} <span class="dim small">运行 / ${host.instanceCount} 总数</span>`],
    ['架构', `${escapeHtml(host.platform.split(' ')[0])} ${host.arch}`],
  ].map(([l, v]) => `<div class="host-item"><div class="h-label">${l}</div><div class="h-value">${v}</div></div>`).join('');

  renderDiskBreakdown(host);
  renderInstGrid();
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
        <button class="icon-btn inst-clone" data-clone="${i.id}" title="克隆实例(复制世界与配置)">⧉</button>
        <button class="icon-btn danger inst-del" data-del="${i.id}" title="删除实例">✕</button>
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
          ? `<div class="inst-stats" style="margin-top:-8px"><span>⇄ <b>${escapeHtml(i.tunnel.addr)}</b></span></div>` : ''}
        <div class="inst-foot">
          <span class="pill ${pillCls}">${i.state === 'installing' ? `安装中 ${i.installProgress || 0}%` : txt}</span>
          <div class="spacer"></div>
          ${i.state === 'stopped'
            ? `<button class="btn btn-green small-btn" data-power="start" data-iid="${i.id}">▶ 启动</button>`
            : i.state === 'installing' ? ''
            : `<button class="btn btn-red small-btn" data-power="stop" data-iid="${i.id}">■ 停止</button>`}
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
    $('#console').scrollTop = $('#console').scrollHeight;
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
  $('#console').scrollTop = $('#console').scrollHeight;
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

function appendLog(entry) {
  // 筛选生效时别把实时日志混进结果里 —— 但仪表盘的迷你日志不受筛选影响,照常追加
  const targets = logFilterOn ? [['#dash-log', 80]] : [['#console', 400], ['#dash-log', 80]];
  for (const [sel, cap] of targets) {
    const el = $(sel);
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    el.insertAdjacentHTML('beforeend', logLineHtml(entry));
    while (el.children.length > cap) el.firstChild.remove();
    if (atBottom) el.scrollTop = el.scrollHeight;
  }
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
  const d = await iapi('/players');
  $('#pl-count').textContent = d.online.length;

  const list = $('#player-list');
  if (!d.online.length) {
    list.innerHTML = '<div class="empty">当前没有在线玩家。启动实例后玩家会陆续加入。</div>';
  } else {
    list.innerHTML = d.online.map((p) => `
      <div class="player-item">
        <div class="avatar" style="background:${avatarColor(p.name)}">${p.name[0].toUpperCase()}</div>
        <div>
          <div class="player-name">${escapeHtml(p.name)} ${p.op ? '<span title="OP">👑</span>' : ''}</div>
          <div class="player-meta">${p.op ? 'OP · ' : ''}在线</div>
        </div>
        <div class="spacer"></div>
        <button class="icon-btn ${p.op ? 'gold' : ''}" data-act="${p.op ? 'deop' : 'op'}" data-name="${p.name}">${p.op ? '取消OP' : '设为OP'}</button>
        <button class="icon-btn danger" data-act="kick" data-name="${p.name}">踢出</button>
        <button class="icon-btn danger" data-act="ban" data-name="${p.name}">封禁</button>
      </div>`).join('');
  }

  $('#ban-list').innerHTML = d.banned.length
    ? d.banned.map((n) => `<span class="tag">${escapeHtml(n)}<button data-act="pardon" data-name="${n}" title="解封">×</button></span>`).join('')
    : '<div class="empty">暂无封禁玩家</div>';

  $('#wl-list').innerHTML = d.whitelist.length
    ? d.whitelist.map((n) => `<span class="tag">${escapeHtml(n)}<button data-act="whitelist-remove" data-name="${n}" title="移除">×</button></span>`).join('')
    : '<div class="empty">白名单为空</div>';
}

$('#view-players').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const r = await iapi(`/players/${encodeURIComponent(btn.dataset.name)}/${btn.dataset.act}`, { method: 'POST' });
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
        ${overworld ? `
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
  if (navBtn) navBtn.innerHTML = `<span class="nav-ico">✦</span>${noun}`;

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
      <div class="mr-icon">${h.icon ? `<img src="${escapeHtml(h.icon)}" alt="" loading="lazy">` : '✦'}</div>
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
  const n = fmSelected().length;
  $('#fm-selinfo').hidden = !n;
  $('#fm-selinfo').textContent = `已选 ${n} 项`;
  $('#fm-zip').hidden = !n;
  $('#fm-targz').hidden = !n;
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
    const ico = e2.type === 'dir' ? '📁' : e2.archive ? '🗜' : e2.binary ? '📦' : '📄';
    const clickable = e2.type === 'dir' || !e2.binary;
    const name = escapeHtml(e2.name);
    return `
      <div class="file-row ${clickable ? 'clickable' : ''}" data-type="${e2.type}" data-binary="${e2.binary}" data-name="${name}" data-path="${escapeHtml(full)}">
        <div class="f-check"><input type="checkbox" data-sel="${name}" title="选中以打包"></div>
        <div class="f-ico">${ico}</div>
        <div class="f-name">${name}</div>
        <div class="f-size">${e2.type === 'dir' ? '—' : fmtSize(e2.size)}</div>
        <div class="f-time">${fmtAgo(e2.mtime)}</div>
        <div class="f-actions">
          ${e2.archive ? `<button class="icon-btn gold" data-fext="${escapeHtml(full)}" data-fname="${name}">解压</button>` : ''}
          <button class="icon-btn" data-fdl="${escapeHtml(full)}" data-fdir="${e2.type === 'dir'}"
            ${e2.type === 'dir' ? 'title="打包成 tar.gz 下载"' : ''}>下载</button>
          <button class="icon-btn" data-fren="${escapeHtml(full)}" data-fname="${name}">改名</button>
          <button class="icon-btn danger" data-fdel="${escapeHtml(full)}">删除</button>
        </div>
      </div>`;
  }).join('');
  $('#fm-list').innerHTML = rows || '<div class="empty">空目录</div>';
  fmSyncSelection();                       // 换目录后勾选作废,顺手把工具栏收回去
}

$('#fm-crumb').addEventListener('click', (e) => {
  const b = e.target.closest('[data-goto]');
  if (b) loadFiles(b.dataset.goto);
});

$('#fm-list').addEventListener('change', (e) => {
  if (e.target.matches('[data-sel]')) fmSyncSelection();
});

$('#fm-list').addEventListener('click', async (e) => {
  // 勾选框自己处理选中,别顺带把文件也打开了
  if (e.target.closest('.f-check')) return;
  if (fmWorking) return toast('压缩任务进行中,请稍候', true);

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

/* ── 上传:XHR(要 upload.progress,fetch 给不了)· body 就是文件本身 ── */

function uploadOne(file, dir, overwrite, onProgress) {
  return new Promise((resolve) => {
    const q = `?path=${encodeURIComponent(dir)}&name=${encodeURIComponent(file.name)}${overwrite ? '&overwrite=1' : ''}`;
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/instances/${currentIid}/files/upload${q}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    });
    xhr.addEventListener('load', () => {
      if (xhr.status === 401) { location.href = '/login'; return resolve({ ok: false, error: '会话已过期' }); }
      let r = null;
      try { r = JSON.parse(xhr.responseText); } catch {}
      resolve(r || { ok: false, error: `HTTP ${xhr.status}` });
    });
    xhr.addEventListener('error', () => resolve({ ok: false, error: '网络错误' }));
    xhr.addEventListener('abort', () => resolve({ ok: false, error: '已取消' }));
    xhr.send(file);
  });
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

  let failed = 0;
  for (let i = 0; i < files.length; i++) {
    const row = box.querySelector(`[data-up="${i}"]`);
    const bar = row.querySelector('.up-bar i');
    const pct = row.querySelector('.up-pct');
    const r = await uploadOne(files[i], dir, existing.has(files[i].name), (p) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      pct.textContent = `${Math.round(p * 100)}%`;
    });
    row.classList.add(r.ok ? 'done' : 'fail');
    bar.style.width = '100%';
    pct.textContent = r.ok ? '完成' : r.error;
    pct.title = r.ok ? '' : r.error;      // 错误文案比列宽长,截断后靠 tooltip 看全
    if (!r.ok) failed++;
  }

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
      <div class="backup-ico">◷</div>
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
    else action = '<span class="task-badge off">未安装(需管理员)</span>';
    const [ico, source] = COMPONENT_META[name];
    const label = { playit: 'playit.gg', ssh: 'ssh(Pinggy / Serveo 使用)' }[name] || name;
    return `
      <div class="backup-item">
        <div class="backup-ico">${ico}</div>
        <div>
          <div class="backup-name">${label}</div>
          <div class="backup-meta">${c.installed ? escapeHtml(c.version || '') : source + comp.arch}</div>
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
  toggleTunnelForm();
  applyTunnelStatus({ state: cfg.state, addr: cfg.addr, error: cfg.error, claim: cfg.claim });
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

$('#tn-save').addEventListener('click', async () => {
  const r = await iapi('/tunnel', {
    method: 'PUT',
    body: {
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
    },
  });
  r.ok ? toast('穿透配置已保存') : toast(r.error, true);
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
  const backups = await iapi('/backups');
  $('#backup-list').innerHTML = backups.length ? backups.map((b) => `
    <div class="backup-item">
      <div class="backup-ico">🗄️</div>
      <div>
        <div class="backup-name">${escapeHtml(b.name)}</div>
        <div class="backup-meta">${fmtSize(b.size)} · ${fmtAgo(b.createdAt)}</div>
      </div>
      <div class="spacer"></div>
      <button class="icon-btn" data-bact="download" data-id="${b.id}">下载</button>
      <button class="icon-btn" data-bact="restore" data-id="${b.id}">恢复</button>
      <button class="icon-btn danger" data-bact="delete" data-id="${b.id}">删除</button>
    </div>`).join('') : '<div class="empty">暂无备份</div>';
}

$('#backup-create').addEventListener('click', async () => {
  const r = await iapi('/backups', { method: 'POST', body: {} });
  if (r.ok) { toast('备份已创建'); loadBackups(); }
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

async function loadUsers() {
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
          ? `实例 ${u.usage.instances}/${u.limits.maxInstances} · 内存 ${u.usage.memMB}/${u.limits.maxMemMB} MB · CPU ${u.limits.maxCpuCores} 核 · 磁盘 ${u.usage.diskMB}/${u.limits.maxDiskMB || '∞'} MB · `
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
  if (d && d.total > rows.length) {
    $('#audit-list').insertAdjacentHTML('beforeend',
      `<div class="dim small" style="padding:8px 4px">共 ${d.total} 条,只显示最近 ${rows.length} 条</div>`);
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
  renderNotify(s.notify);
  loadAudit();
}

$('#sys-save').addEventListener('click', async () => {
  const r = await api('/settings', {
    method: 'PUT',
    body: {
      registrationEnabled: $('#sys-reg').checked,
      announcement: $('#sys-announcement').value,
      backupKeepCount: parseInt($('#sys-bk-count').value, 10) || 0,
      backupKeepDays: parseInt($('#sys-bk-days').value, 10) || 0,
    },
  });
  if (r.ok) { toast('系统设置已保存'); renderAnnouncement(r.settings); }
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
      $('#oauth-bind-btn').textContent = `绑定 ${s.name} 账号(绑定后可第三方登录)`;
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
  $('#me-name').textContent = me.username;
  $('#me-role').textContent = me.role === 'admin' ? '管理员' : '普通用户';
  $('#me-avatar').textContent = me.username[0].toUpperCase();
  $('#me-avatar').style.background = avatarColor(me.username);
  if (me.role === 'admin') $$('.admin-only').forEach((el) => { el.hidden = false; });
  if (me.defaultPassword) toast('你仍在使用默认密码,请点击侧栏 🔑 尽快修改', true);

  const list = await api('/instances');
  instMap = new Map(list.map((i) => [i.id, i]));
  if (!currentIid || !instMap.has(currentIid)) currentIid = list[0] ? list[0].id : null;
  renderInstSelect();
  if (currentIid) await refreshInstanceContext();
  switchView('overview');
  connectStream();
  loadAnnouncement();
})();
