/**
 * 邀请链接(功能 10)。
 *
 * 原来要让朋友用上面板,只有两条路:开「开放注册」(等于对全世界开放),
 * 或者管理员手动建号再把密码发过去(密码就这么进了聊天记录)。
 * 邀请链接是中间那条:一次性、可设有效期、自带配额,用完即焚。
 *
 * 存 data/invites.json。token 是 32 字节随机十六进制,和会话 token 同规格 ——
 * 链接本身就是凭据,能猜到就等于能注册。
 *
 * 刻意做的取舍:
 *   · 不发邮件。面板没有 SMTP 配置,也不该为这个引入依赖;链接怎么送到
 *     对方手上是使用者的事。
 *   · 邀请注册**不受**「开放注册」总开关影响 —— 那个开关管的是"陌生人能不能
 *     自己注册",而邀请是管理员逐个签发的,两件事。
 *   · 只能建普通用户,不能用邀请造管理员。一个泄露的链接不该能拿到面板控制权。
 */
const crypto = require('crypto');
const path = require('path');
const { DATA_DIR } = require('./config');
const { readJson, writeJson } = require('./utils');

const FILE = path.join(DATA_DIR, 'invites.json');

/** [{ token, createdBy, createdAt, expiresAt, limits, note, usedBy, usedAt }] */
const invites = readJson(FILE, []);
const save = () => writeJson(FILE, invites);

const isUsed = (i) => !!i.usedBy;
const isExpired = (i) => !!i.expiresAt && Date.now() > i.expiresAt;
const isLive = (i) => !isUsed(i) && !isExpired(i);

function create({ createdBy, expiresInHours, limits, note }) {
  const h = parseInt(expiresInHours, 10);
  const invite = {
    token: crypto.randomBytes(32).toString('hex'),
    createdBy,
    createdAt: Date.now(),
    // 0 / 空 = 永不过期。默认 168 小时(7 天):一个链接躺在聊天记录里
    // 半年后还能用,是个安静的风险
    expiresAt: Number.isFinite(h) && h > 0 ? Date.now() + h * 3600_000 : 0,
    limits: limits || null,
    note: String(note || '').slice(0, 100),
    usedBy: null,
    usedAt: 0,
  };
  invites.push(invite);
  save();
  return invite;
}

function find(token) {
  return invites.find((i) => i.token === token) || null;
}

/** 校验并返回邀请;不可用时返回 { error } */
function check(token) {
  const inv = find(token);
  if (!inv) return { error: '邀请链接无效' };
  if (isUsed(inv)) return { error: '这个邀请链接已经被使用过了' };
  if (isExpired(inv)) return { error: '邀请链接已过期' };
  return { invite: inv };
}

function consume(token, username) {
  const inv = find(token);
  if (!inv) return;
  inv.usedBy = username;
  inv.usedAt = Date.now();
  save();
}

function revoke(token) {
  const i = invites.findIndex((x) => x.token === token);
  if (i < 0) return false;
  invites.splice(i, 1);
  save();
  return true;
}

/** 列表(管理员看)。已用/过期的也留着 —— "谁邀请了谁"本身是要留痕的 */
function list() {
  return invites
    .map((i) => ({
      token: i.token, createdBy: i.createdBy, createdAt: i.createdAt,
      expiresAt: i.expiresAt, note: i.note, limits: i.limits,
      usedBy: i.usedBy, usedAt: i.usedAt,
      status: isUsed(i) ? 'used' : (isExpired(i) ? 'expired' : 'live'),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

module.exports = { create, check, consume, revoke, list, isLive };
