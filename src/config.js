/** 全局路径与常量 */
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');

const config = {
  ROOT,
  PORT: process.env.PORT || 3000,
  PUBLIC_DIR: path.join(ROOT, 'public'),
  DATA_DIR: path.join(ROOT, 'data'),
  INSTANCES_DIR: path.join(ROOT, 'instances'),
  BACKUPS_DIR: path.join(ROOT, 'backups'),
  BIN_DIR: path.join(ROOT, 'bin'),
  JAVA_BIN: process.env.JAVA_BIN || 'java',
  // 单个上传文件的大小上限(整合包/世界压缩包可能很大,默认 2 GB)
  MAX_UPLOAD_MB: Math.max(1, parseInt(process.env.MCSP_MAX_UPLOAD_MB, 10) || 2048),
  // 解压后总体积上限:挡 zip bomb,别让一个 1 MB 的包把磁盘写满(默认 8 GB)
  MAX_EXTRACT_MB: Math.max(1, parseInt(process.env.MCSP_MAX_EXTRACT_MB, 10) || 8192),
  TUNNEL_ARCH: os.arch() === 'arm64' ? 'arm64' : 'amd64',
  PANEL_STARTED: Date.now(),
  SESSION_TTL_MS: 7 * 86400_000,
};

config.USERS_FILE = path.join(config.DATA_DIR, 'users.json');
config.SESSIONS_FILE = path.join(config.DATA_DIR, 'sessions.json');
config.REGISTRY_FILE = path.join(config.DATA_DIR, 'instances.json');
config.TASKS_FILE = path.join(config.DATA_DIR, 'tasks.json');

for (const d of [config.DATA_DIR, config.INSTANCES_DIR, config.BACKUPS_DIR, config.BIN_DIR]) {
  fs.mkdirSync(d, { recursive: true });
}

module.exports = config;
