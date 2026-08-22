/** 真实备份:tar.gz 全量归档,备份前自动 save-all */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BACKUPS_DIR } = require('./config');
const settings = require('./settings');

function backupDir(inst) {
  const d = path.join(BACKUPS_DIR, inst.id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function listBackups(inst) {
  return fs.readdirSync(backupDir(inst))
    .filter((f) => f.endsWith('.tar.gz'))
    .map((f) => {
      const st = fs.statSync(path.join(backupDir(inst), f));
      return { id: f, name: f.replace(/\.tar\.gz$/, ''), size: st.size, sizeMB: +(st.size / 1048576).toFixed(1), createdAt: st.mtimeMs };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 按保留策略清理旧备份(份数 + 天数,各自 0 表示不限)。
 * 只在备份成功后调用 —— 备份是唯一让这个目录变大的动作,
 * 在那一刻收一次就够,不用再养一个后台定时器。
 */
function pruneBackups(inst) {
  const { backupKeepCount, backupKeepDays } = settings.get();
  if (!backupKeepCount && !backupKeepDays) return [];
  const all = listBackups(inst);            // 已按 createdAt 倒序
  const doomed = new Set();
  if (backupKeepCount > 0) for (const b of all.slice(backupKeepCount)) doomed.add(b.id);
  if (backupKeepDays > 0) {
    const cutoff = Date.now() - backupKeepDays * 86400000;
    for (const b of all) if (b.createdAt < cutoff) doomed.add(b.id);
  }
  // 最新的一份永远留着:天数配得比备份间隔还短时,不能把刚做完的这份也删了
  if (all.length) doomed.delete(all[0].id);

  const removed = [];
  for (const id of doomed) {
    try { fs.unlinkSync(path.join(backupDir(inst), id)); removed.push(id); }
    catch (err) { inst.log('WARN', `[MCSP] 清理旧备份失败 ${id}: ${err.message}`); }
  }
  if (removed.length) {
    inst.log('INFO', `[MCSP] 已清理 ${removed.length} 份旧备份(保留策略:${backupKeepCount || '不限'} 份 / ${backupKeepDays || '不限'} 天)`);
  }
  return removed;
}

function createBackup(inst, name) {
  return new Promise((resolve) => {
    const safe = String(name || `manual-${Date.now()}`).replace(/[^\w.-]+/g, '_').slice(0, 60);
    const out = path.join(backupDir(inst), `${safe}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.tar.gz`);
    inst.log('INFO', `[MCSP] 开始备份到 ${path.basename(out)}`);
    if (inst.proc) inst.command('save-all');
    const tar = spawn('tar', ['czf', out, '-C', inst.dir, '.']);
    tar.on('exit', (code) => {
      if (code === 0) {
        inst.log('INFO', `[MCSP] 备份完成: ${path.basename(out)}`);
        pruneBackups(inst);
        resolve({ ok: true });
      } else {
        inst.log('ERROR', `[MCSP] 备份失败 (tar exit ${code})`);
        // 失败会留下半截的 tar.gz,不删掉它会一直占着保留份数
        fs.rmSync(out, { force: true });
        resolve({ ok: false, error: `tar 退出码 ${code}` });
      }
    });
  });
}

function restoreBackup(inst, id) {
  return new Promise((resolve) => {
    const file = path.join(backupDir(inst), id);
    if (!fs.existsSync(file) || !id.endsWith('.tar.gz')) return resolve({ ok: false, error: '备份不存在' });
    const tar = spawn('tar', ['xzf', file, '-C', inst.dir]);
    tar.on('exit', (code) => {
      if (code === 0) {
        inst.log('INFO', `[MCSP] 已从 ${id} 恢复`);
        resolve({ ok: true });
      } else resolve({ ok: false, error: `tar 退出码 ${code}` });
    });
  });
}

module.exports = { backupDir, listBackups, createBackup, restoreBackup, pruneBackups };
