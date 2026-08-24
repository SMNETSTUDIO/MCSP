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
  /* 分片上传的片大小。默认 5 MB 是被反代逼出来的:实测常见的隧道 / Worker 链路
     在请求体 10 MB 出头就直接 502(请求根本到不了面板),5 MB 给头部和框架开销留足
     余量。上限开到 64 是给前面没有这种限制的部署用的 —— 真调大了又撞墙,症状就是
     每一片都 502。 */
  UPLOAD_CHUNK_MB: Math.min(64, Math.max(1, parseInt(process.env.MCSP_UPLOAD_CHUNK_MB, 10) || 5)),
  // 浏览器同时在途的上传请求数;分片之间、文件之间共用这一个额度
  UPLOAD_CONCURRENCY: Math.min(8, Math.max(1, parseInt(process.env.MCSP_UPLOAD_CONCURRENCY, 10) || 3)),
  // 分片会话多久没动静就回收。按"最后一片"算,慢速大文件不该被扫掉
  UPLOAD_SESSION_TTL_MS: 6 * 3600_000,
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
