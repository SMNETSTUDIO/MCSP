/** 真实备份:tar.gz 全量归档,备份前自动 save-all */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { BACKUPS_DIR } = require('./config');

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
        resolve({ ok: true });
      } else {
        inst.log('ERROR', `[MCSP] 备份失败 (tar exit ${code})`);
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

module.exports = { backupDir, listBackups, createBackup, restoreBackup };
