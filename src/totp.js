/**
 * TOTP(RFC 6238)两步验证。
 *
 * 自己实现而不是引依赖:算法本身只有二十来行(HMAC-SHA1 + 动态截断),
 * 而这个面板到现在为止只有 express 一个运行时依赖,为二十行代码引一棵
 * 依赖树不划算,何况它还处在认证路径上。
 *
 * 有意不生成二维码:唯一省事的做法是把密钥拼进第三方二维码服务的 URL,
 * 那等于把用户的 2FA 种子发给别人。自己实现 QR 编码(Reed-Solomon)又不是
 * 这个模块该干的事。所以给出密钥和 otpauth:// 链接,让用户手动添加。
 */
const crypto = require('crypto');

const DIGITS = 6;
const PERIOD = 30;
/* 允许前后各一个时间窗:手机和服务器差几十秒是常态,
   卡在 0 容忍上会让一堆人以为自己输错了 */
const WINDOW = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const c of String(str).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 20 字节随机种子,base32 表示 */
const generateSecret = () => base32Encode(crypto.randomBytes(20));

/** 某个时间步的 6 位码 */
function codeAt(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;               // 动态截断
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * 校验用户输入。前后各放一个窗口。
 * 用 timingSafeEqual 而不是 === :6 位码只有一百万种可能,
 * 逐字符早退的比较在理论上能被计时探测。
 */
function verify(secret, token) {
  const clean = String(token || '').replace(/\D/g, '');
  if (clean.length !== DIGITS || !secret) return false;
  const now = Math.floor(Date.now() / 1000 / PERIOD);
  for (let w = -WINDOW; w <= WINDOW; w++) {
    const expect = codeAt(secret, now + w);
    if (crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(clean))) return true;
  }
  return false;
}

/** 认证器 App 认的标准链接 */
function otpauthUrl(secret, account, issuer = 'MCSP') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
    + `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=${DIGITS}&period=${PERIOD}`;
}

/** 恢复码:2FA 设备丢了还能进得来,否则用户就把自己永久锁在外面了 */
function generateRecoveryCodes(n = 8) {
  return Array.from({ length: n }, () => crypto.randomBytes(5).toString('hex').toUpperCase().match(/.{1,5}/g).join('-'));
}

module.exports = { generateSecret, verify, otpauthUrl, codeAt, generateRecoveryCodes, PERIOD };
