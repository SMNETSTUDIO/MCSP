/**
 * 服务端类型注册表:统一各官方下载源的「版本列表查询」与「下载解析」。
 *
 *   paper / folia / velocity / waterfall — PaperMC fill v3 API
 *   purpur    — PurpurMC v2 API
 *   vanilla   — Mojang piston-meta(全部正式版,含远古版本)
 *   fabric    — FabricMC meta(捆绑启动器,单 jar 直接可跑)
 *   forge     — MinecraftForge promotions + maven(官方安装器流程)
 *   neoforge  — NeoForged maven(官方安装器流程)
 *   bungeecord— SpigotMC 官方 Jenkins
 *
 * Spigot 官方只提供 BuildTools 源码编译、无直链,故不收录
 * (Paper / Purpur 均为其超集,插件完全兼容)。
 */

/**
 * 类型元数据:
 *   category    server=Minecraft 服务端(写 eula/server.properties)| proxy=群组代理
 *   dataDir     实例目录下的扩展目录(plugins / mods)
 *   installer   true = 下载的是官方安装器,需要 java --installServer 二段安装
 *   stopCommand 优雅停服的控制台命令
 */
const TYPES = {
  paper:      { label: 'Paper',      category: 'server', dataDir: 'plugins' },
  purpur:     { label: 'Purpur',     category: 'server', dataDir: 'plugins' },
  folia:      { label: 'Folia',      category: 'server', dataDir: 'plugins', note: '多线程区块,插件需适配 Folia' },
  vanilla:    { label: 'Vanilla',    category: 'server', dataDir: null },
  fabric:     { label: 'Fabric',     category: 'server', dataDir: 'mods' },
  forge:      { label: 'Forge',      category: 'server', dataDir: 'mods', installer: true, note: '将运行官方安装器下载依赖库,耗时数分钟' },
  neoforge:   { label: 'NeoForge',   category: 'server', dataDir: 'mods', installer: true, note: '将运行官方安装器下载依赖库,耗时数分钟' },
  velocity:   { label: 'Velocity 代理',   category: 'proxy', dataDir: 'plugins', stopCommand: 'shutdown' },
  waterfall:  { label: 'Waterfall 代理',  category: 'proxy', dataDir: 'plugins', stopCommand: 'end' },
  bungeecord: { label: 'BungeeCord 代理', category: 'proxy', dataDir: 'plugins', stopCommand: 'end' },
};

const caches = new Map(); // key -> { at, data },1 小时

async function cached(key, fn) {
  const hit = caches.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.data;
  const data = await fn();
  caches.set(key, { at: Date.now(), data });
  return data;
}

async function fetchJson(url, timeout = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.json();
}

async function fetchText(url, timeout = 15000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`${new URL(url).host} HTTP ${res.status}`);
  return res.text();
}

/** "1.20.4" 风格版本号降序排序(新版本在前) */
function semverDesc(list) {
  const key = (v) => String(v).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  return [...list].sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < Math.max(ka.length, kb.length); i++) {
      if ((kb[i] || 0) !== (ka[i] || 0)) return (kb[i] || 0) - (ka[i] || 0);
    }
    return 0;
  });
}

/* ── PaperMC 家族(fill v3) ── */

const FILL = 'https://fill.papermc.io/v3/projects';

async function fillVersions(project) {
  const data = await fetchJson(`${FILL}/${project}`);
  return semverDesc(Object.values(data.versions || {}).flat().filter((v) => /^[\d.]+(-SNAPSHOT)?$/.test(v)));
}

async function fillDownload(project, version) {
  const build = await fetchJson(`${FILL}/${project}/versions/${version}/builds/latest`);
  const dl = build.downloads && build.downloads['server:default'];
  if (!dl || !dl.url) throw new Error('该版本没有可用构建');
  return { url: dl.url, name: dl.name, size: dl.size, sha256: dl.checksums && dl.checksums.sha256 };
}

/* ── Vanilla(Mojang piston-meta) ── */

async function vanillaManifest() {
  return cached('vanilla-manifest', () =>
    fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'));
}

async function vanillaVersions() {
  const m = await vanillaManifest();
  return m.versions.filter((v) => v.type === 'release').map((v) => v.id);
}

async function vanillaDownload(version) {
  const m = await vanillaManifest();
  const entry = m.versions.find((v) => v.id === version);
  if (!entry) throw new Error(`未知版本 ${version}`);
  const detail = await fetchJson(entry.url);
  const dl = detail.downloads && detail.downloads.server;
  if (!dl) throw new Error('该版本 Mojang 未提供官方服务端 jar(1.2.5 之前无服务端下载)');
  return { url: dl.url, name: `minecraft_server-${version}.jar`, size: dl.size, sha1: dl.sha1 };
}

/* ── Fabric(meta,捆绑启动器单 jar) ── */

async function fabricVersions() {
  const list = await fetchJson('https://meta.fabricmc.net/v2/versions/game');
  return list.filter((v) => v.stable).map((v) => v.version);
}

async function fabricDownload(version) {
  const [loaders, installers] = await Promise.all([
    cached('fabric-loader', () => fetchJson('https://meta.fabricmc.net/v2/versions/loader')),
    cached('fabric-installer', () => fetchJson('https://meta.fabricmc.net/v2/versions/installer')),
  ]);
  const loader = (loaders.find((l) => l.stable) || loaders[0]).version;
  const installer = (installers.find((i) => i.stable) || installers[0]).version;
  return {
    url: `https://meta.fabricmc.net/v2/versions/loader/${version}/${loader}/${installer}/server/jar`,
    name: `fabric-server-${version}.jar`,
  };
}

/* ── Forge(promotions + maven 安装器) ── */

async function forgePromos() {
  return cached('forge-promos', async () => {
    const data = await fetchJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
    return data.promos || {};
  });
}

async function forgeVersions() {
  const promos = await forgePromos();
  return semverDesc([...new Set(Object.keys(promos).map((k) => k.replace(/-(latest|recommended)$/, '')))]);
}

async function forgeDownload(version) {
  const promos = await forgePromos();
  const forgeVer = promos[`${version}-recommended`] || promos[`${version}-latest`];
  if (!forgeVer) throw new Error(`Forge 不支持 MC ${version}`);
  const base = 'https://maven.minecraftforge.net/net/minecraftforge/forge';
  const full = `${version}-${forgeVer}`;
  return {
    // 远古版本 maven 坐标带分支后缀(如 1.7.10-…-1.7.10),按序尝试
    candidates: [
      `${base}/${full}/forge-${full}-installer.jar`,
      `${base}/${full}-${version}/forge-${full}-${version}-installer.jar`,
    ],
    name: `forge-${full}-installer.jar`,
  };
}

/* ── NeoForge(maven 安装器) ──
 * 旧版号 X.Y.Z ↔ MC 1.X.Y(如 21.1.77 → 1.21.1);
 * 2026 起 MC 改用年份版本,NeoForge 版号 = MC 版本 + 构建号
 * (26.1.2.97 → MC 26.1.2,26.2.0.64 → MC 26.2,末尾 .0 省略)。 */

async function neoforgeAll() {
  return cached('neoforge-versions', async () => {
    const xml = await fetchText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
    return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
      .filter((v) => /^\d+(\.\d+)+(-beta)?$/.test(v));   // 排除愚人节等特殊版本
  });
}

const neoToMc = (v) => {
  const seg = v.replace(/-beta$/, '').split('.');
  if (parseInt(seg[0], 10) >= 26) {                      // 年份版本时代
    const mc = seg.slice(0, -1);
    while (mc.length > 2 && mc[mc.length - 1] === '0') mc.pop();
    return mc.join('.');
  }
  return seg[1] === '0' ? `1.${seg[0]}` : `1.${seg[0]}.${seg[1]}`;
};

async function neoforgeVersions() {
  const all = await neoforgeAll();
  return semverDesc([...new Set(all.map(neoToMc))]);
}

async function neoforgeDownload(version) {
  const all = await neoforgeAll();
  const matches = all.filter((v) => neoToMc(v) === version);
  if (!matches.length) throw new Error(`NeoForge 不支持 MC ${version}`);
  // 优先最新正式版,全是 beta 则取最新 beta(按版本号排序,maven 文件序不可靠)
  const stable = matches.filter((v) => !v.includes('-beta'));
  const pick = semverDesc(stable.length ? stable : matches)[0];
  return {
    url: `https://maven.neoforged.net/releases/net/neoforged/neoforge/${pick}/neoforge-${pick}-installer.jar`,
    name: `neoforge-${pick}-installer.jar`,
  };
}

/* ── 对外接口 ── */

async function typeVersions(type) {
  switch (type) {
    case 'paper': case 'folia': case 'velocity': case 'waterfall':
      return cached(`fill-${type}`, () => fillVersions(type));
    case 'purpur':
      return cached('purpur', async () =>
        semverDesc((await fetchJson('https://api.purpurmc.org/v2/purpur')).versions || []));
    case 'vanilla': return vanillaVersions();
    case 'fabric': return cached('fabric-game', fabricVersions);
    case 'forge': return forgeVersions();
    case 'neoforge': return neoforgeVersions();
    case 'bungeecord': return ['latest'];
    default: throw new Error(`未知服务端类型 ${type}`);
  }
}

/** 解析下载计划:{ url | candidates, name, size?, sha256?, sha1? } */
async function resolveDownload(type, version) {
  switch (type) {
    case 'paper': case 'folia': case 'velocity': case 'waterfall':
      return fillDownload(type, version);
    case 'purpur':
      return {
        url: `https://api.purpurmc.org/v2/purpur/${version}/latest/download`,
        name: `purpur-${version}.jar`,
      };
    case 'vanilla': return vanillaDownload(version);
    case 'fabric': return fabricDownload(version);
    case 'forge': return forgeDownload(version);
    case 'neoforge': return neoforgeDownload(version);
    case 'bungeecord':
      return {
        url: 'https://ci.md-5.net/job/BungeeCord/lastSuccessfulBuild/artifact/bootstrap/target/BungeeCord.jar',
        name: 'BungeeCord.jar',
      };
    default: throw new Error(`未知服务端类型 ${type}`);
  }
}

function listTypes() {
  return Object.entries(TYPES).map(([key, t]) => ({ key, label: t.label, category: t.category, note: t.note || null }));
}

module.exports = { TYPES, listTypes, typeVersions, resolveDownload };
