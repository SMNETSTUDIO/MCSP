/**
 * Modrinth 搜索与安装。
 *
 * 选 Modrinth 而不是 SpigotMC / CurseForge:它有公开、无需 API key 的 v2 REST 接口,
 * 而且同一套接口同时覆盖 Bukkit 插件和 Fabric/Forge 模组 —— 面板两种实例都要用。
 * (CurseForge 要申请 key,SpigotMC 根本没有官方下载 API。)
 *
 * 下载的文件带 sha1,装完必须校验 —— 这是从公网往用户服务器里放可执行 jar,
 * 不校验就等于信任任何中间人。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const API = 'https://api.modrinth.com/v2';
// Modrinth 要求带能识别来源的 UA,否则可能限流
const UA = 'MCSP-Panel/1.0 (github.com/SMNETSTUDIO/MCSP)';
const TIMEOUT_MS = 20000;

/** 面板的服务端类型 → Modrinth 的 loader 名 */
const LOADERS = {
  paper: ['paper', 'spigot', 'bukkit'],
  purpur: ['purpur', 'paper', 'spigot', 'bukkit'],
  folia: ['folia', 'paper'],
  fabric: ['fabric'],
  forge: ['forge'],
  neoforge: ['neoforge'],
  velocity: ['velocity'],
  waterfall: ['waterfall', 'bungeecord'],
  bungeecord: ['bungeecord'],
  vanilla: [],          // 原版装不了
};

const loadersFor = (type) => LOADERS[type] || [];

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Modrinth HTTP ${res.status}`);
  return res.json();
}

/**
 * 搜索。按实例的 loader 和 MC 版本过滤 —— 不过滤的话搜出来一堆装不上的东西,
 * 用户点了才发现不兼容。
 */
async function search({ query, type, version, limit = 20 }) {
  const loaders = loadersFor(type);
  if (!loaders.length) throw new Error('原版(Vanilla)服务端不支持插件或模组');
  const facets = [loaders.map((l) => `categories:${l}`)];
  if (version) facets.push([`versions:${version}`]);
  const url = `${API}/search?query=${encodeURIComponent(query || '')}`
    + `&limit=${Math.min(50, Math.max(1, limit))}`
    + `&index=relevance&facets=${encodeURIComponent(JSON.stringify(facets))}`;
  const j = await get(url);
  return {
    total: j.total_hits,
    hits: (j.hits || []).map((h) => ({
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      downloads: h.downloads,
      icon: h.icon_url || null,
      categories: (h.display_categories || []).slice(0, 4),
      url: `https://modrinth.com/project/${h.slug}`,
    })),
  };
}

/** 某项目在该实例上可用的版本列表(新→旧) */
async function versions({ projectId, type, version }) {
  const loaders = loadersFor(type);
  if (!loaders.length) throw new Error('原版(Vanilla)服务端不支持插件或模组');
  const url = `${API}/project/${encodeURIComponent(projectId)}/version`
    + `?loaders=${encodeURIComponent(JSON.stringify(loaders))}`
    + (version ? `&game_versions=${encodeURIComponent(JSON.stringify([version]))}` : '');
  const list = await get(url);
  return list.map((v) => {
    const f = v.files.find((x) => x.primary) || v.files[0];
    return {
      id: v.id,
      name: v.name,
      versionNumber: v.version_number,
      gameVersions: v.game_versions,
      loaders: v.loaders,
      channel: v.version_type,          // release / beta / alpha
      datePublished: v.date_published,
      file: f && { filename: f.filename, url: f.url, size: f.size, sha1: (f.hashes || {}).sha1 },
    };
  }).filter((v) => v.file);
}

/**
 * 下载指定版本到 destDir。返回 { filename, size }。
 * 先写临时文件、校验 sha1 通过后再 rename —— 校验失败绝不能留下一个
 * 半截或被篡改的 jar 在 plugins/ 里等着被加载。
 */
async function install({ projectId, versionId, type, version, destDir }) {
  const list = await versions({ projectId, type, version });
  const target = versionId ? list.find((v) => v.id === versionId) : list[0];
  if (!target) throw new Error('没有找到与当前服务端类型/版本匹配的发布');

  const { filename, url, sha1 } = target.file;
  if (!/^[\w.\-+ ()\[\]]+\.jar$/i.test(filename)) throw new Error(`文件名异常,拒绝安装: ${filename}`);
  if (!/^https:\/\/cdn\.modrinth\.com\//.test(url)) throw new Error('下载地址不是 Modrinth CDN,拒绝安装');

  await fsp.mkdir(destDir, { recursive: true });
  const tmp = path.join(destDir, `.mcsp-dl-${crypto.randomUUID().slice(0, 8)}`);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(300000) });
    if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
    const hash = crypto.createHash('sha1');
    const ws = fs.createWriteStream(tmp);
    let size = 0;
    for await (const chunk of res.body) {
      hash.update(chunk);
      size += chunk.length;
      if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
    }
    await new Promise((r, j) => ws.end((e) => (e ? j(e) : r())));

    const got = hash.digest('hex');
    if (sha1 && got !== sha1) throw new Error(`SHA-1 校验失败(期望 ${sha1.slice(0, 12)}…,实得 ${got.slice(0, 12)}…)`);

    await fsp.rename(tmp, path.join(destDir, filename));
    return { filename, size, versionNumber: target.versionNumber, verified: !!sha1 };
  } catch (err) {
    await fsp.rm(tmp, { force: true });
    throw err;
  }
}

module.exports = { search, versions, install, loadersFor };
