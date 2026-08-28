/**
 * 自定义 OAuth2 第三方登录(标准授权码流程,参考 StarLive 的做法):
 * 管理员在「用户管理 → OAuth 第三方登录」配置任意提供商
 * (名称 + client id/secret + authorize/token/userinfo 三端点),
 * 登录页自动出现「使用 XX 登录」。首次登录可自动建号(可关),
 * 也可在登录后把第三方身份绑定到已有账号。
 *
 * 配置存 data/oauth.json;state 一次性防 CSRF,10 分钟过期。
 */
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const { checkOutboundUrl } = require('./utils');
const { DATA_DIR } = require('./config');
const { readJson, writeJson } = require('./utils');
const auth = require('./auth');
const { sanitizeLimits } = require('./routes/users');

const OAUTH_FILE = path.join(DATA_DIR, 'oauth.json');
const SECRET_MASK = '••••••••';

const DEFAULTS = {
  providerName: '',
  clientId: '',
  clientSecret: '',
  authUrl: '',       // 授权页,如 https://connect.linux.do/oauth2/authorize
  tokenUrl: '',      // 换 token,如 https://connect.linux.do/oauth2/token
  userInfoUrl: '',   // 用户信息,如 https://connect.linux.do/api/user
  scope: 'read',
  redirectUri: '',   // 留空则按请求 Host 自动生成 <origin>/api/auth/oauth/callback
  autoCreate: true,  // 未绑定的第三方身份首次登录时自动创建普通用户
  // 自动建号用户的资源配额(可在面板 OAuth 配置里调整)
  defaultLimits: { maxInstances: 1, maxMemMB: 2048, maxCpuCores: 2 },
};

const config = { ...DEFAULTS, ...readJson(OAUTH_FILE, {}) };
const saveConfig = () => writeJson(OAUTH_FILE, config);
const enabled = () => Boolean(config.clientId && config.authUrl && config.tokenUrl && config.userInfoUrl);

/* ── state 防 CSRF:一次性、10 分钟过期;绑定流程的 state 额外携带发起用户 ── */

const states = new Map(); // state -> { bindUser: string|null, at: number }

function newState(bindUser = null) {
  const s = crypto.randomBytes(16).toString('hex');
  states.set(s, { bindUser, at: Date.now() });
  return s;
}

function takeState(s) {
  for (const [k, v] of states) if (Date.now() - v.at > 600_000) states.delete(k);
  const v = states.get(s);
  states.delete(s);
  return v || null;
}

/* ── 授权码流程 ── */

function redirectUri(req) {
  return config.redirectUri || `${req.protocol}://${req.get('host')}/api/auth/oauth/callback`;
}

function authorizeUrl(req, state) {
  const p = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri(req),
    response_type: 'code',
    scope: config.scope || 'read',
    state,
  });
  return `${config.authUrl}?${p}`;
}

/** code 换 token 再取用户信息;返回稳定身份标识 oauthId */
async function fetchIdentity(req, code) {
  /* 这两个地址是管理员填的,面板拿着它们从**服务端**发请求 —— 指向内网就是 SSRF。
     而且 token 请求会把 clientSecret 一起带过去,填错/被改成内网地址等于把密钥
     送给那个地址。发之前校验一次。 */
  for (const [url, label] of [[config.tokenUrl, 'OAuth token 端点'], [config.userInfoUrl, 'OAuth userinfo 端点']]) {
    const bad = await checkOutboundUrl(url, { label });
    if (bad) throw new Error(bad);
  }
  // OAuth2 标准要求 token 端点用 form-urlencoded(linux.do 等不解析 JSON body)
  const tokenRes = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri(req),
    }).toString(),
    signal: AbortSignal.timeout(15000),
  });
  const token = await tokenRes.json().catch(() => ({}));
  if (!token.access_token) {
    throw new Error(token.error_description || token.error || `token 端点 HTTP ${tokenRes.status}`);
  }
  const infoRes = await fetch(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(15000),
  });
  const info = await infoRes.json().catch(() => ({}));
  const oauthId = String(info.id ?? info.sub ?? info.username ?? '');
  if (!oauthId) throw new Error('userinfo 响应缺少 id / sub / username 字段');
  return { oauthId, info };
}

const setSessionCookie = (res, token) =>
  res.setHeader('Set-Cookie', `mcsp_session=${token}; HttpOnly; Path=/; Max-Age=${7 * 86400}; SameSite=Lax`);

/* ── 公开路由(挂载于 /api/auth/oauth,无需登录)── */

const router = express.Router();

const failTo = (res, msg) => res.redirect('/login?oauth_error=' + encodeURIComponent(msg));

router.get('/status', (req, res) => {
  res.json({ enabled: enabled(), name: config.providerName || 'OAuth' });
});

router.get('/login', (req, res) => {
  if (!enabled()) return failTo(res, 'OAuth 未配置');
  res.redirect(authorizeUrl(req, newState()));
});

/* 登录用户发起绑定:把第三方身份挂到当前账号 */
router.get('/bind', (req, res) => {
  const sess = auth.getSession(req);
  if (!sess) return res.redirect('/login');
  if (!enabled()) return failTo(res, 'OAuth 未配置');
  res.redirect(authorizeUrl(req, newState(sess.username)));
});

router.get('/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code || !state) return failTo(res, '回调缺少 code / state 参数');
    const st = takeState(String(state));
    if (!st) return failTo(res, 'state 无效或已过期,请重新发起登录');

    const { oauthId, info } = await fetchIdentity(req, String(code));

    /* 绑定流程 */
    if (st.bindUser) {
      if (auth.users.some((u) => u.oauthId === oauthId && u.username !== st.bindUser)) {
        return failTo(res, '该第三方账号已绑定到其他用户');
      }
      const user = auth.users.find((u) => u.username === st.bindUser);
      if (!user) return failTo(res, '发起绑定的用户不存在');
      user.oauthId = oauthId;
      auth.saveUsers();
      return res.redirect('/');
    }

    /* 登录流程:已绑定 → 直接登录;未绑定 → 自动建号(需同时开启系统「开放注册」与 OAuth「自动建号」) */
    const settings = require('./settings');   // 延迟加载,避免装配期循环依赖
    let user = auth.users.find((u) => u.oauthId === oauthId);
    if (!user && config.autoCreate && !settings.get().registrationEnabled) {
      return failTo(res, '注册已关闭,请联系管理员开通账号后绑定登录');
    }
    if (!user && config.autoCreate) {
      const base = ('oauth_' + oauthId).replace(/[^\w.-]/g, '').slice(0, 24);
      let username = base, n = 1;
      while (auth.users.some((u) => u.username === username)) username = `${base.slice(0, 20)}_${n++}`;
      user = {
        username,
        // 无本地密码(随机散列),只能通过 OAuth 登录;管理员可重置密码开启本地登录
        password: auth.hashPassword(crypto.randomBytes(24).toString('hex')),
        role: 'user',
        createdAt: Date.now(),
        oauthId,
        oauthName: String(info.username || info.name || ''),
        limits: sanitizeLimits(config.defaultLimits),   // OAuth 配置里设定的建号配额,之后可按用户单独调
      };
      auth.users.push(user);
      auth.saveUsers();
    }
    if (!user) {
      return failTo(res, `该 ${config.providerName || 'OAuth'} 账号未绑定面板用户;请先用密码登录,在「修改密码」弹窗中绑定`);
    }
    setSessionCookie(res, auth.createSession(user.username, req));
    res.redirect('/');
  } catch (err) {
    failTo(res, `OAuth 登录失败: ${err.message}`);
  }
});

/* ── 管理路由(挂载于 /api/oauth,经全局 requireAuth,再要求管理员)── */

const adminRouter = express.Router();
adminRouter.use(auth.requireAdmin);

adminRouter.get('/config', (req, res) => {
  res.json({ ...config, clientSecret: config.clientSecret ? SECRET_MASK : '', enabled: enabled() });
});

adminRouter.put('/config', (req, res) => {
  const b = req.body || {};
  const next = { ...config };
  for (const k of ['providerName', 'clientId', 'authUrl', 'tokenUrl', 'userInfoUrl', 'scope', 'redirectUri']) {
    if (k in b) next[k] = String(b[k] || '').trim();
  }
  if ('clientSecret' in b && b.clientSecret !== SECRET_MASK) next.clientSecret = String(b.clientSecret || '').trim();
  if ('autoCreate' in b) next.autoCreate = !!b.autoCreate;
  if ('defaultLimits' in b) next.defaultLimits = sanitizeLimits(b.defaultLimits);
  for (const k of ['authUrl', 'tokenUrl', 'userInfoUrl', 'redirectUri']) {
    if (next[k] && !/^https?:\/\//.test(next[k])) {
      return res.status(400).json({ ok: false, error: `${k} 必须是 http(s):// 开头的 URL` });
    }
  }
  Object.assign(config, next);
  saveConfig();
  res.json({ ok: true, enabled: enabled() });
});

module.exports = { router, adminRouter };
