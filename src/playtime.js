/**
 * 玩家在线时长统计(功能 14)。
 *
 * 数据来源就是控制台里那两行 "X joined the game" / "X left the game" ——
 * 面板本来就在解析它们来维护在线列表,这里顺手把时间也记下来。
 * 不读服务端的 stats/*.json:那是按 UUID 存的原版统计,盗版服/离线模式下
 * UUID 每次都可能变,而且代理服(Velocity/Bungee)根本没有这个目录。
 *
 * 每实例一个文件 data/playtime/<iid>.json:
 *   { "Steve": { totalMs, sessions, firstSeen, lastSeen, lastJoin } }
 *
 * lastJoin 是"这次进服的时刻",只在内存里有意义;落盘是为了处理面板重启:
 * 重启时如果有人还在线,那段时间没人记 —— 与其瞎猜,不如在重启时把未闭合的
 * 会话按"面板停止时刻"结算掉(见 closeOpenSessions),宁可少算不要多算。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const { readJson } = require('./utils');

const DIR = path.join(DATA_DIR, 'playtime');

/** iid → { name → rec };懒加载,面板启动时不去读几十个文件 */
const cache = new Map();

function fileOf(iid) { return path.join(DIR, `${iid}.json`); }

function load(iid) {
  if (!cache.has(iid)) cache.set(iid, readJson(fileOf(iid), {}));
  return cache.get(iid);
}

/* 写盘攒一下再落:一个热闹的服务器每分钟几十次进出,没必要每次都同步写 */
const timers = new Map();
function save(iid) {
  clearTimeout(timers.get(iid));
  timers.set(iid, setTimeout(() => {
    try {
      fs.mkdirSync(DIR, { recursive: true });
      fs.writeFileSync(fileOf(iid), JSON.stringify(load(iid)));
    } catch { /* 统计数据丢了不影响开服,不值得往上抛 */ }
  }, 2000));
}

function rec(iid, name) {
  const all = load(iid);
  if (!all[name]) all[name] = { totalMs: 0, sessions: 0, firstSeen: Date.now(), lastSeen: 0, lastJoin: 0 };
  return all[name];
}

function onJoin(iid, name, at = Date.now()) {
  const r = rec(iid, name);
  r.lastJoin = at;
  r.lastSeen = at;
  save(iid);
}

function onLeave(iid, name, at = Date.now()) {
  const r = rec(iid, name);
  if (r.lastJoin) {
    const d = at - r.lastJoin;
    // 负数或离谱的时长(改过系统时间、日志乱序)一律丢弃,别污染总数
    if (d > 0 && d < 30 * 86400_000) { r.totalMs += d; r.sessions++; }
  }
  r.lastJoin = 0;
  r.lastSeen = at;
  save(iid);
}

/**
 * 结算所有还开着的会话。实例停止/崩溃、面板退出时调用 ——
 * 不结算的话这些人的 lastJoin 会一直挂着,下次他再进服就会被算成
 * "从上次进服到现在一直在线",凭空多出几天时长。
 */
function closeOpenSessions(iid, at = Date.now()) {
  const all = load(iid);
  let closed = 0;
  for (const [name, r] of Object.entries(all)) {
    if (!r.lastJoin) continue;
    onLeave(iid, name, at);
    closed++;
  }
  if (closed) save(iid);
  return closed;
}

/** 排行榜:按总时长降序 */
function list(iid, online = new Set()) {
  const all = load(iid);
  const now = Date.now();
  return Object.entries(all)
    .map(([name, r]) => ({
      name,
      // 在线的人要把"当前这段还没结算的"加上,否则看着像时间停住了
      totalMs: r.totalMs + (r.lastJoin && online.has(name) ? now - r.lastJoin : 0),
      sessions: r.sessions,
      firstSeen: r.firstSeen,
      lastSeen: r.lastSeen,
      online: online.has(name),
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
}

function reset(iid) {
  cache.set(iid, {});
  try { fs.rmSync(fileOf(iid), { force: true }); } catch {}
}

/** 删实例时顺手清掉,不留孤儿文件 */
function remove(iid) {
  cache.delete(iid);
  try { fs.rmSync(fileOf(iid), { force: true }); } catch {}
}

module.exports = { onJoin, onLeave, closeOpenSessions, list, reset, remove };
