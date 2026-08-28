/**
 * 异地备份目标(功能 6):把备份包同步到本机之外。
 *
 * 为什么必须有:备份和被备份的东西现在放在同一块盘上。盘坏了、机器被回收、
 * 或者手滑 rm 掉整个目录,备份陪葬 —— 那等于没有备份。
 *
 * 三种目标,覆盖绝大多数人手边已有的东西:
 *   s3      任何 S3 兼容存储(AWS / MinIO / R2 / B2 / 阿里云 OSS…)
 *   webdav  Nextcloud / 坚果云 / 群晖,家用 NAS 最省事的一条路
 *   rclone  以上都不是的时候的万能出口(要求宿主机装了 rclone)
 *
 * 全部不引第三方依赖 —— 这个项目的 runtime 依赖只有 express,为了上传
 * 拖进整个 aws-sdk(几十 MB)不成比例。S3 的 SigV4 签名在下面手写,
 * 一百来行,用的都是 node 自带的 crypto。
 *
 * 设计上的硬约束:**上传失败绝不能影响本地备份**。本地那份已经做完了,
 * 远端传不上去是另一件事,报警即可。把两者绑在一起的话,一个过期的
 * access key 会让所有备份任务开始"失败",而实际上本地备份好好的。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');
const { checkOutboundUrl } = require('./utils');

const UPLOAD_TIMEOUT_MS = 30 * 60_000;   // 几十 GB 的世界包走慢线路可能真要这么久

/* ── S3:SigV4 签名 ── */

const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest();

/** URI 编码:S3 要求每段单独编码,且 '/' 不转义(路径分隔符保留) */
function encodeKey(key) {
  return key.split('/').map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())).join('/');
}

/**
 * 生成 PUT 对象的签名头。
 * payload 用 UNSIGNED-PAYLOAD:否则要先把整个文件读一遍算 sha256,
 * 几十 GB 的包等于白白多读一次盘。S3 与各家兼容实现都接受这个值。
 */
function signS3Put(cfg, key, contentLength) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20260823T161500Z
  const dateStamp = amzDate.slice(0, 8);
  const region = cfg.region || 'us-east-1';
  const service = 's3';
  const host = s3Host(cfg);
  const canonicalUri = `/${cfg.pathStyle ? `${cfg.bucket}/` : ''}${encodeKey(key)}`;
  const payloadHash = 'UNSIGNED-PAYLOAD';

  const headers = {
    host,
    'content-length': String(contentLength),
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort()
    .map((h) => `${h}:${String(headers[h]).trim()}\n`).join('');

  const canonicalRequest = [
    'PUT', canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${cfg.secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  headers.Authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, `
    + `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers, canonicalUri };
}

/**
 * endpoint 形如 https://s3.us-east-1.amazonaws.com 或 http://minio.lan:9000。
 *
 * 这里要区分两个东西,混用会直接连不上:
 *   host     —— HTTP Host 头的值,**带端口**(非默认端口时);SigV4 把它算进
 *               签名,少了端口对面会算出不同的签名而拒签
 *   hostname —— 建连用的主机名,**不带端口**;端口单独走 port 选项。
 *               把带端口的字符串塞给 hostname 会当成域名去解析,
 *               报 ENOTFOUND 127.0.0.1:9000
 * virtual-host 风格还要在前面拼上 bucket。
 */
function s3Parts(cfg) {
  const u = new URL(cfg.endpoint);
  const vhost = !cfg.pathStyle;
  return {
    proto: u.protocol === 'http:' ? http : https,
    hostname: vhost ? `${cfg.bucket}.${u.hostname}` : u.hostname,
    port: u.port || undefined,
    host: vhost ? `${cfg.bucket}.${u.host}` : u.host,
  };
}

const s3Host = (cfg) => s3Parts(cfg).host;

function uploadS3(cfg, localPath, key) {
  return new Promise((resolve, reject) => {
    let size;
    try { size = fs.statSync(localPath).size; } catch (e) { return reject(new Error(`读取本地文件失败: ${e.message}`)); }
    const { proto, hostname, port } = s3Parts(cfg);
    const { headers, canonicalUri } = signS3Put(cfg, key, size);
    const req = proto.request({
      method: 'PUT', hostname, port, path: canonicalUri, headers,
      timeout: UPLOAD_TIMEOUT_MS,
    }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true });
        // S3 的错误正文是 XML,把 <Message> 抠出来,比甩一整坨 XML 给用户有用
        const m = /<Message>([^<]+)<\/Message>/.exec(body);
        reject(new Error(`S3 返回 ${res.statusCode}${m ? ': ' + m[1] : ''}`));
      });
    });
    req.on('timeout', () => req.destroy(new Error('上传超时')));
    req.on('error', reject);
    fs.createReadStream(localPath).on('error', reject).pipe(req);
  });
}

/* ── WebDAV ── */

function uploadWebdav(cfg, localPath, key) {
  return new Promise((resolve, reject) => {
    let size;
    try { size = fs.statSync(localPath).size; } catch (e) { return reject(new Error(`读取本地文件失败: ${e.message}`)); }
    const base = cfg.url.replace(/\/+$/, '');
    const u = new URL(`${base}/${key.split('/').map(encodeURIComponent).join('/')}`);
    const proto = u.protocol === 'http:' ? http : https;
    const req = proto.request({
      method: 'PUT', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search,
      timeout: UPLOAD_TIMEOUT_MS,
      headers: {
        'content-length': String(size),
        Authorization: 'Basic ' + Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64'),
      },
    }, (res) => {
      res.resume();
      if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ ok: true });
      // 409 基本都是目标目录不存在 —— WebDAV 不会自动建父目录,单独点出来
      if (res.statusCode === 409) return reject(new Error('WebDAV 返回 409:目标目录不存在,请先在网盘上建好'));
      reject(new Error(`WebDAV 返回 ${res.statusCode}`));
    });
    req.on('timeout', () => req.destroy(new Error('上传超时')));
    req.on('error', reject);
    fs.createReadStream(localPath).on('error', reject).pipe(req);
  });
}

/* ── rclone ── */

function uploadRclone(cfg, localPath, key) {
  return new Promise((resolve, reject) => {
    const dest = `${cfg.remote.replace(/:$/, '')}:${(cfg.path || '').replace(/^\/+|\/+$/g, '')}/${key}`
      .replace(/\/{2,}/g, '/').replace(':/', ':');
    const p = spawn('rclone', ['copyto', localPath, dest, '--no-traverse'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => reject(new Error(
      e.code === 'ENOENT' ? '宿主机没有安装 rclone(需要 rclone 在 PATH 中)' : e.message)));
    const timer = setTimeout(() => p.kill('SIGKILL'), UPLOAD_TIMEOUT_MS);
    p.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      reject(new Error(`rclone 退出码 ${code}${err ? ': ' + err.trim().slice(0, 300) : ''}`));
    });
  });
}

/* ── 对外 ── */

function validate(cfg) {
  if (!cfg || !cfg.enabled) return '未启用';
  if (cfg.type === 's3') {
    if (!cfg.endpoint || !cfg.bucket || !cfg.accessKey || !cfg.secretKey) return 'S3 需要填写 endpoint / bucket / accessKey / secretKey';
    try { new URL(cfg.endpoint); } catch { return 'S3 endpoint 不是合法 URL(需带 http:// 或 https://)'; }
  } else if (cfg.type === 'webdav') {
    if (!cfg.url || !cfg.username) return 'WebDAV 需要填写 url 与用户名';
    try { new URL(cfg.url); } catch { return 'WebDAV url 不是合法 URL'; }
  } else if (cfg.type === 'rclone') {
    if (!cfg.remote) return 'rclone 需要填写 remote 名(rclone config 里配好的那个)';
  } else {
    return `未知的异地备份类型: ${cfg.type}`;
  }
  return null;
}

/**
 * 上传一个备份文件。remoteKey 形如 <实例名>/<文件名>,
 * 按实例分目录 —— 几个实例的包混在一个桶里,出事时根本找不着。
 */
async function upload(cfg, localPath, remoteKey) {
  const err = validate(cfg);
  if (err) throw new Error(err);
  /* 内网校验放在这里而不是 validate():validate 是同步的,而 DNS 解析是异步的。
     test() 也走 upload,所以「连通性自检」那条带回显的路径一并覆盖到了。
     rclone 不填 URL(用的是本地 rclone config 里的 remote 名),跳过。 */
  const target = cfg.type === 's3' ? cfg.endpoint : cfg.type === 'webdav' ? cfg.url : null;
  if (target) {
    const bad = await checkOutboundUrl(target, { label: cfg.type === 's3' ? 'S3 endpoint' : 'WebDAV 地址' });
    if (bad) throw new Error(bad);
  }
  const prefix = (cfg.prefix || '').replace(/^\/+|\/+$/g, '');
  const key = prefix ? `${prefix}/${remoteKey}` : remoteKey;
  if (cfg.type === 's3') return uploadS3(cfg, localPath, key);
  if (cfg.type === 'webdav') return uploadWebdav(cfg, localPath, key);
  return uploadRclone(cfg, localPath, key);
}

/**
 * 连通性自检:传一个几十字节的探针文件上去。
 * 只验"能不能连"是不够的 —— 权限、桶名、路径这些只有真写一次才知道。
 */
async function test(cfg) {
  const err = validate(cfg);
  if (err) return { ok: false, error: err };
  const tmp = path.join(require('os').tmpdir(), `mcsp-remote-probe-${process.pid}`);
  fs.writeFileSync(tmp, `MCSP remote backup probe\n`);
  try {
    await upload(cfg, tmp, '.mcsp-connectivity-probe.txt');
    return { ok: true, note: '已成功写入一个探针文件 .mcsp-connectivity-probe.txt,可自行删除' };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { upload, test, validate };
