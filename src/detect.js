/**
 * 从一个已存在的服务器目录反推它是什么 —— 服务端类型、MC 版本、端口。
 *
 * 用于「导入已有服务器」:用户扔进来一个别处跑着的服务端目录,面板得先认出
 * 它是 Paper 还是 Fabric、哪个版本,才能挑对 Java 运行时和启动参数。
 *
 * 认不出来不是错误 —— 返回 null 让用户自己在设置页选,总比猜错一个类型
 * 然后用错的参数把服务端拉崩要好。
 */
const fs = require('fs');
const path = require('path');

/* jar 文件名 → 服务端类型。顺序有讲究:先匹配更具体的。
   比如 Purpur 的 jar 里也含 "paper" 字样的情况要靠先命中 purpur 排除掉 */
const JAR_PATTERNS = [
  [/^purpur(-|\.)/i,                    'purpur'],
  [/^folia(-|\.)/i,                     'folia'],
  [/^paper(-|\.)/i,                     'paper'],
  [/^velocity(-|\.)/i,                  'velocity'],
  [/^waterfall(-|\.)/i,                 'waterfall'],
  [/^bungeecord(-|\.)/i,                'bungeecord'],
  [/^fabric-server/i,                   'fabric'],
  [/^(neoforge|neoforged)(-|\.)/i,      'neoforge'],
  [/^forge(-|\.)/i,                     'forge'],
  [/^minecraft_server(-|\.|$)/i,        'vanilla'],
  [/^server\.jar$/i,                    'vanilla'],
];

/* 目录布局也能作证:这些文件/目录存在就基本能定性 */
const DIR_MARKERS = [
  ['fabric',    ['.fabric', 'fabric-server-launcher.properties']],
  ['neoforge',  ['libraries/net/neoforged']],
  ['forge',     ['libraries/net/minecraftforge']],
  ['velocity',  ['velocity.toml']],
  ['waterfall', ['waterfall.yml']],
  ['bungeecord',['config.yml', 'modules']],
];

/** 从 "paper-1.21.4-232.jar" 之类的名字里抠出 MC 版本 */
function versionFromJarName(name) {
  const m = name.match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

/** Paper 系会写 version_history.json,里面的 "(MC: 1.21.4)" 最可信 */
function versionFromHistory(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'version_history.json'), 'utf8'));
    const m = String(j.currentVersion || '').match(/MC:\s*([\d.]+)/);
    if (m) return m[1];
    return versionFromJarName(String(j.currentVersion || ''));
  } catch { return null; }
}

/** 兜底:日志里几乎一定印过版本号 */
function versionFromLog(dir) {
  for (const rel of ['logs/latest.log', 'logs/latest.log.gz']) {
    if (rel.endsWith('.gz')) continue;                 // 不为了兜底去解压
    try {
      const head = fs.readFileSync(path.join(dir, rel), 'utf8').slice(0, 20000);
      const m = head.match(/(?:for Minecraft|Starting minecraft server version)\s+([\d.]+)/i);
      if (m) return m[1];
    } catch { /* 没日志很正常,继续 */ }
  }
  return null;
}

function readProps(dir) {
  const out = {};
  try {
    for (const line of fs.readFileSync(path.join(dir, 'server.properties'), 'utf8').split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      const i = s.indexOf('=');
      if (i > 0) out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
    }
  } catch { /* 代理服没有 server.properties,正常 */ }
  return out;
}

/**
 * 探测一个目录。返回 { type, version, port, gamemode, levelName, jar, confidence, notes[] }
 * type/version 认不出时为 null,交给用户在导入表单里确认。
 */
function detectServer(dir) {
  const notes = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch {
    return { type: null, version: null, port: null, jar: null, confidence: 'none', notes: ['目录读不到'] };
  }

  const jars = entries.filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.jar')).map((e) => e.name);

  let type = null, jar = null;
  for (const name of jars) {
    const hit = JAR_PATTERNS.find(([re]) => re.test(name));
    if (hit) { type = hit[1]; jar = name; break; }
  }

  // jar 名字没认出来就看目录布局
  if (!type) {
    for (const [t, markers] of DIR_MARKERS) {
      if (markers.every((m) => fs.existsSync(path.join(dir, m)))) { type = t; break; }
    }
    if (type) notes.push('按目录结构判断类型,jar 文件名未能识别');
  }

  // 还是没有:有 jar 就当原版,没 jar 就彻底放弃
  if (!type && jars.length) { type = 'vanilla'; jar = jars[0]; notes.push('未能识别服务端类型,暂按 Vanilla 处理'); }
  if (!jar && jars.length) jar = jars[0];

  const version = versionFromHistory(dir) || (jar && versionFromJarName(jar)) || versionFromLog(dir);
  if (!version) notes.push('未能识别 MC 版本,请在设置页确认');

  const props = readProps(dir);
  const port = parseInt(props['server-port'], 10) || null;

  /* 从别处搬来的服务器一般已经同意过 EULA,但如果用户是把一个刚解开、
     从没跑过的服务端包传上来,没有 eula.txt 服务端会直接拒绝启动,
     而那条 "Failed to load eula.txt" 埋在日志里没人看得见 */
  const isServer = type && !['velocity', 'waterfall', 'bungeecord'].includes(type);
  if (isServer) {
    let accepted = false;
    try { accepted = /eula\s*=\s*true/i.test(fs.readFileSync(path.join(dir, 'eula.txt'), 'utf8')); } catch { /* 没有就是没同意 */ }
    if (!accepted) notes.push('未找到已同意的 eula.txt,启动前需要在设置里同意 Minecraft EULA');
  }

  // 三条线索都指向同一个结论才算高置信
  const confidence = type && version && jar ? 'high' : type ? 'low' : 'none';

  return {
    type, version, jar, port,
    gamemode: props.gamemode || null,
    levelName: props['level-name'] || null,
    maxPlayers: parseInt(props['max-players'], 10) || null,
    motd: props.motd || null,
    confidence, notes,
  };
}

/**
 * 压缩包解出来常常多套一层目录(server.zip 里是 server/…)。
 * 找到真正的服务器根:自身有 jar 就是自身,否则唯一子目录里有 jar 就下潜一层。
 */
function findServerRoot(dir, depth = 0) {
  const hasJar = () => {
    try { return fs.readdirSync(dir).some((n) => n.toLowerCase().endsWith('.jar')); } catch { return false; }
  };
  if (hasJar() || depth >= 2) return dir;
  let subs = [];
  try {
    subs = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  } catch { return dir; }
  if (subs.length !== 1) return dir;              // 不止一个子目录就不猜了
  return findServerRoot(path.join(dir, subs[0].name), depth + 1);
}

module.exports = { detectServer, findServerRoot };
