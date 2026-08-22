/**
 * 磁盘用量:宿主机分区 + 每实例占用。
 *
 * 每实例的体积要递归 stat 整个目录(一个世界几万个文件),不能在请求里现算 ——
 * 所以后台按固定间隔扫一遍缓存起来,接口和配额检查都读缓存。
 * 代价是配额有最长一个扫描周期的滞后,对"别把磁盘占满"这个目的够用了。
 */
const fsp = require('fs/promises');
const path = require('path');
const { ROOT, BACKUPS_DIR } = require('./config');
const { dirSize } = require('./utils');
const notify = require('./notify');

/* 磁盘占用超过这个比例就告警一次(去重 5 分钟,由 notify 负责) */
const DISK_WARN_PCT = 90;

const SCAN_INTERVAL_MS = 60_000;

/** iid → { instMB, backupMB, totalMB, at } */
const usage = new Map();
let scanning = false;

/** 面板所在分区的容量;statfs 拿不到(Node < 18.15 / 非常规文件系统)就返回 null */
async function hostDisk() {
  try {
    const st = await fsp.statfs(ROOT);
    const totalMB = Math.round((st.blocks * st.bsize) / 1048576);
    // 用 bavail 而不是 bfree:后者含 root 保留块,普通用户其实用不到
    const freeMB = Math.round((st.bavail * st.bsize) / 1048576);
    if (!totalMB) return null;
    return { totalMB, freeMB, usedMB: totalMB - freeMB, usedPct: Math.round(((totalMB - freeMB) / totalMB) * 100) };
  } catch {
    return null;
  }
}

async function measure(inst) {
  const instMB = (await dirSize(inst.dir)) / 1048576;
  const backupMB = (await dirSize(path.join(BACKUPS_DIR, inst.id))) / 1048576;
  return {
    instMB: +instMB.toFixed(1),
    backupMB: +backupMB.toFixed(1),
    totalMB: +(instMB + backupMB).toFixed(1),
    at: Date.now(),
  };
}

/** 扫一遍所有实例;串行走,免得几十个实例同时递归 stat 把 IO 打满 */
async function scan() {
  if (scanning) return;
  scanning = true;
  try {
    const d = await hostDisk();
    if (d && d.usedPct >= DISK_WARN_PCT) {
      notify.emit('diskLow', {
        title: `宿主机磁盘已用 ${d.usedPct}%`,
        text: `已用 ${(d.usedMB / 1024).toFixed(1)} GB / 共 ${(d.totalMB / 1024).toFixed(1)} GB,`
          + `剩余 ${(d.freeMB / 1024).toFixed(1)} GB。备份保留策略可在系统设置里收紧。`,
        dedupeKey: 'host',
      });
    }
    const { instances } = require('./registry');
    for (const inst of instances.values()) {
      try { usage.set(inst.id, await measure(inst)); } catch {}
    }
    for (const iid of [...usage.keys()]) if (!instances.has(iid)) usage.delete(iid);
  } finally {
    scanning = false;
  }
}

function startDiskLoop() {
  scan();
  setInterval(scan, SCAN_INTERVAL_MS).unref();
}

/** 单个实例的占用;还没扫到返回全 0(而不是 null,省得每个调用方都判空) */
const instanceUsage = (iid) => usage.get(iid) || { instMB: 0, backupMB: 0, totalMB: 0, at: 0 };

/** 某个用户名下所有实例的占用合计(MB) */
function userUsageMB(username) {
  const { instances } = require('./registry');
  let total = 0;
  for (const inst of instances.values()) {
    if (inst.owner === username) total += instanceUsage(inst.id).totalMB;
  }
  return Math.round(total);
}

/**
 * 写入成功后立刻把增量记到缓存上。
 * 这条是配额能生效的关键 —— 只靠 60s 的定时扫描的话,用户能在两次扫描之间
 * 连传十几个大文件,每次看到的都是同一个"还没超"的旧数字。
 * 记多了不要紧,下一轮扫描会纠正回来。
 */
function bump(iid, deltaMB, kind = 'inst') {
  // 缓存里还没有这个实例(刚建出来、后台还没扫到)时要**建一条**而不是直接返回:
  // 否则新实例在第一次扫描前是配额盲区,能一口气传爆配额。
  // 从 0 起算会短暂少报已有内容,下一轮扫描会纠正。
  let u = usage.get(iid);
  if (!u) { u = { instMB: 0, backupMB: 0, totalMB: 0, at: 0 }; usage.set(iid, u); }
  const key = kind === 'backup' ? 'backupMB' : 'instMB';
  u[key] = Math.max(0, +(u[key] + deltaMB).toFixed(1));
  u.totalMB = +(u.instMB + u.backupMB).toFixed(1);
}

/** 立刻重算某个实例(删除大文件、跑完备份后调用,免得等一整个扫描周期) */
async function refresh(iid) {
  const { instances } = require('./registry');
  const inst = instances.get(iid);
  if (!inst) return;
  try { usage.set(iid, await measure(inst)); } catch {}
}

module.exports = { hostDisk, startDiskLoop, instanceUsage, userUsageMB, bump, refresh };
