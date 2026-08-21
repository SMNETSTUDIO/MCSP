/**
 * authlib-injector 外置登录支持(https://manual.littlesk.in/yggdrasil/authlib-injector)
 * 下载并缓存 authlib-injector.jar,启动实例时以 -javaagent 注入 Yggdrasil API。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { BIN_DIR } = require('./config');
const { downloadFile } = require('./utils');

const AUTHLIB_JAR = path.join(BIN_DIR, 'authlib-injector.jar');
// 官方最新版本元数据;拿不到时回退到固定版本直链
const LATEST_META = 'https://authlib-injector.yushi.moe/artifact/latest.json';
const FALLBACK_URL = 'https://authlib-injector.yushi.moe/artifact/56/authlib-injector-1.2.8.jar';

function authlibJarPath() { return AUTHLIB_JAR; }
function authlibInstalled() { return fs.existsSync(AUTHLIB_JAR); }

/** 确保 authlib-injector.jar 就绪(已存在直接复用);返回 jar 路径 */
async function ensureAuthlibInjector() {
  if (authlibInstalled()) return AUTHLIB_JAR;
  let url = FALLBACK_URL;
  let sha256 = null;
  try {
    const r = await fetch(LATEST_META, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const meta = await r.json();
      if (meta.download_url) url = meta.download_url;
      sha256 = (meta.checksums && meta.checksums.sha256) || null;
    }
  } catch {}
  const tmp = AUTHLIB_JAR + '.download';
  try {
    await downloadFile(url, tmp);
    if (sha256) {
      const got = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
      if (got !== sha256) throw new Error('authlib-injector 校验失败(sha256 不匹配)');
    }
    fs.renameSync(tmp, AUTHLIB_JAR);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return AUTHLIB_JAR;
}

module.exports = { authlibJarPath, authlibInstalled, ensureAuthlibInjector };
