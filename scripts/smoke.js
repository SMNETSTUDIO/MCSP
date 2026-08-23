#!/usr/bin/env node
/**
 * 冒烟测试:对运行中的面板做一轮真实 API 回归。
 * 用法: node scripts/smoke.js [baseUrl] [username] [password] [totpSecret]
 * 默认: http://localhost:3000 admin admin123
 *
 * totpSecret 是可选的 Base32 密钥:测试账号开了两步验证时必须给,
 * 否则登录会卡在 need2fa 上、后面每一条用例都跟着假失败。
 * 开了「强制两步验证」的面板尤其需要 —— 那时所有账号都必须有 TOTP。
 */
const BASE = process.argv[2] || 'http://localhost:3000';
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'admin123';
const TOTP_SECRET = process.argv[5] || process.env.MCSP_SMOKE_TOTP || '';

let cookie = '';
let passed = 0, failed = 0;

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/**
 * 增量备份链(功能 5)。
 *
 * 重点不是"能不能生成",而是链的完整性 —— 增量恢复错一步得到的是几个时间点
 * 混在一起的世界,它看起来是成功的,这比恢复失败危险得多。
 * 所以这里专测:元数据对不对、链断了会不会拒绝、清理会不会把全量删了留下孤儿。
 */
async function incrementalBackupSuite(iid) {
  let r = await req('POST', `/api/instances/${iid}/backups`, { name: 'smoke-inc', mode: 'full' });
  check('incremental: 建立全量基准', r.json && r.json.ok && r.json.mode === 'full', JSON.stringify(r.json));
  const fullId = r.json && r.json.id;

  r = await req('POST', `/api/instances/${iid}/backups`, { name: 'smoke-inc', mode: 'incremental' });
  const incOk = r.json && r.json.ok && r.json.mode === 'incremental';
  check('incremental: 追加增量', incOk, JSON.stringify(r.json));
  const incId = r.json && r.json.id;

  r = await req('GET', `/api/instances/${iid}/backups`);
  const list = Array.isArray(r.json) ? r.json : [];
  const inc = list.find((b) => b.id === incId);
  check('incremental: 列表带链元数据',
    !!inc && inc.type === 'inc' && inc.base === fullId && inc.seq >= 1,
    JSON.stringify(inc));

  // 预览要把"要按顺序应用几个归档"讲清楚
  r = await req('GET', `/api/instances/${iid}/backups/${incId}/inspect`);
  check('incremental: 预览列出整条链',
    r.json && r.json.ok && Array.isArray(r.json.chain) && r.json.chain.length >= 2 && r.json.chain[0] === fullId,
    JSON.stringify(r.json && r.json.chain));

  // 全量的预览不该带链
  r = await req('GET', `/api/instances/${iid}/backups/${fullId}/inspect`);
  check('incremental: 全量预览为单份', r.json && r.json.ok && r.json.type === 'full'
    && (!r.json.chain || r.json.chain.length === 1), JSON.stringify(r.json && r.json.chain));

  // 删掉基准全量后,增量必须拒绝恢复而不是解出半个世界
  await req('DELETE', `/api/instances/${iid}/backups/${fullId}`);
  r = await req('POST', `/api/instances/${iid}/backups/${incId}/restore`);
  check('incremental: 链断裂时拒绝恢复',
    r.json && r.json.ok === false && /全量|不完整/.test(r.json.error || ''), JSON.stringify(r.json));

  await req('DELETE', `/api/instances/${iid}/backups/${incId}`);
}

/**
 * 协作者权限档(功能 8)。
 *
 * 权限代码最危险的失败方式是"悄悄放行"—— 所以这里逐档打真实端点看状态码,
 * 而不是只验接口回了什么。特别是 viewer:它必须连一个写操作都做不了。
 */
async function collabRoleSuite(iid) {
  const adminCookie = cookie;
  const tag = Date.now().toString(36).slice(-4);
  const users = { viewer: `sv_${tag}`, operator: `so_${tag}`, manager: `sm_${tag}` };
  const pass = 'smokepass123';
  let r;

  for (const u of Object.values(users)) {
    await req('POST', '/api/users', { username: u, password: pass, role: 'user' });
  }
  // 记下原有名单,跑完原样放回去 —— 别把别人的协作者配置洗掉
  r = await req('GET', `/api/instances/${iid}/status`);
  const original = (r.json && r.json.collaborators) || [];

  r = await req('PUT', `/api/instances/${iid}/collaborators`, {
    users: Object.entries(users).map(([role, name]) => ({ name, role })),
  });
  check('collab roles: 设置三档', r.json && r.json.ok
    && r.json.collaborators.length === 3
    && r.json.collaborators.every((c) => c.name && c.role), JSON.stringify(r.json));

  /** 以某个用户身份打一个端点,返回状态码。GET 不能带 body,fetch 会直接抛 */
  const as = async (user, method, sub, body) => {
    cookie = '';
    await req('POST', '/api/auth/login', { username: user, password: pass });
    const isRead = method === 'GET' || method === 'HEAD';
    const res = await req(method, `/api/instances/${iid}${sub}`, isRead ? undefined : (body || {}));
    return res.status;
  };

  // viewer:读得到,写不了(挑三个不同性质的写操作)
  check('collab viewer: 可读状态', (await as(users.viewer, 'GET', '/status')) === 200);
  check('collab viewer: 禁止发命令', (await as(users.viewer, 'POST', '/command', { command: 'list' })) === 403);
  check('collab viewer: 禁止建备份', (await as(users.viewer, 'POST', '/backups')) === 403);
  check('collab viewer: 禁止改配置', (await as(users.viewer, 'PATCH', '', { name: 'x' })) === 403);

  // operator:能做日常运维,但改不了配置
  check('collab operator: 可建备份', (await as(users.operator, 'POST', '/backups')) === 200);
  check('collab operator: 禁止改配置', (await as(users.operator, 'PATCH', '', { name: 'x' })) === 403);

  // manager:配置也能改,但仍然碰不到所有权级操作
  check('collab manager: 可改配置', (await as(users.manager, 'PATCH', '', {})) === 200);
  check('collab manager: 禁止改协作者名单',
    (await as(users.manager, 'PUT', '/collaborators', { users: [] })) === 403);
  check('collab manager: 禁止删实例', (await as(users.manager, 'DELETE', '')) === 403);

  /* 删用户要把他从协作者名单里摘干净。只按字符串比会漏掉 {name,role} 形态,
     留下一条指向已删除用户的记录 —— 这个 bug 真发生过 */
  cookie = adminCookie;
  r = await req('DELETE', `/api/users/${users.viewer}`);
  check('collab roles: 删用户会摘掉其协作者身份',
    r.json && r.json.ok && r.json.removedFromInstances >= 1, JSON.stringify(r.json));
  r = await req('GET', `/api/instances/${iid}/status`);
  check('collab roles: 名单里不留已删用户',
    !(r.json.collaborators || []).some((c) => c.name === users.viewer),
    JSON.stringify(r.json.collaborators));

  // 收尾:还原原名单并删掉剩下的测试账号。
  // 原名单里可能有已经不存在的用户(别处删号留下的残留),那种情况 PUT 会拒绝 ——
  // 那不是本用例要验的东西,所以只断言"测试账号没留下",不做全等比较
  await req('PUT', `/api/instances/${iid}/collaborators`, { users: original });
  for (const u of [users.operator, users.manager]) await req('DELETE', `/api/users/${u}`);
  r = await req('GET', `/api/instances/${iid}/status`);
  const left = (r.json && r.json.collaborators) || [];
  check('collab roles: 测试账号未残留',
    !left.some((c) => Object.values(users).includes(c.name)), JSON.stringify(left));
}

/**
 * RCON 端口穿透的安全闸门。
 *
 * 这个功能把服务器控制台挂到公网,而 RCON 是明文协议、几乎没有防爆破 ——
 * 所以真正要守的不是"能不能开",是"该拒绝的时候有没有拒绝"。
 * 用例全部走真实端点、只看会不会被放行,不依赖任何外部中继。
 * 跑完把穿透配置还原,不留痕。
 */
async function rconTunnelSuite(iid) {
  const before = (await req('GET', `/api/instances/${iid}/tunnel`)).json;
  const origType = before.config.type;
  const start = () => req('POST', `/api/instances/${iid}/tunnel/rcon/start`, {});
  let r;

  // 面板上可能已经开着一条(手动开的、或上次跑到一半中断)。
  // 不先收掉的话后面每个 start 都只会回"已在运行",测的就不是校验逻辑了
  await req('POST', `/api/instances/${iid}/tunnel/rcon/stop`);

  await req('PUT', `/api/instances/${iid}/tunnel`, { type: 'none' });
  r = await start();
  check('rcon tunnel: 未选穿透方式时拒绝',
    r.json.ok === false && /穿透方式/.test(r.json.error || ''), JSON.stringify(r.json));

  await req('PUT', `/api/instances/${iid}/tunnel`, { type: 'playit' });
  r = await start();
  check('rcon tunnel: playit 明确不支持',
    r.json.ok === false && /playit/.test(r.json.error || ''), JSON.stringify(r.json));

  /* 下面几条依赖 server.properties 的 RCON 设置。实例可能压根没这个文件,
     那时后端会认为"RCON 未开启"—— 一样是拒绝,断言写宽一点即可。 */
  await req('PUT', `/api/instances/${iid}/tunnel`, { type: 'bore', bore: { server: 'bore.pub' } });
  const props = (await req('GET', `/api/instances/${iid}/rcon`)).json;
  r = await start();
  if (!props.enabled) {
    check('rcon tunnel: RCON 未开启时拒绝',
      r.json.ok === false && /RCON/.test(r.json.error || ''), JSON.stringify(r.json));
  } else if (!props.password || props.password.length < 12) {
    check('rcon tunnel: 弱密码时拒绝',
      r.json.ok === false && /密码/.test(r.json.error || ''), JSON.stringify(r.json));
  } else {
    // 密码够强:此时唯一该挡住它的就是"组件没装",不该是权限或校验问题
    check('rcon tunnel: 强密码时通过校验(仅可能卡在组件未安装)',
      r.json.ok === true || /尚未安装/.test(r.json.error || ''), JSON.stringify(r.json));
    if (r.json.ok) await req('POST', `/api/instances/${iid}/tunnel/rcon/stop`);
  }

  // 启动请求带的 remotePort 应被持久化,且不该动到穿透类型
  await req('POST', `/api/instances/${iid}/tunnel/rcon/start`, { remotePort: 45678 });
  const after = (await req('GET', `/api/instances/${iid}/tunnel`)).json;
  check('rcon tunnel: 启动请求里的端口被记住', after.config.rcon.remotePort === 45678,
    JSON.stringify(after.config.rcon));
  check('rcon tunnel: 启动不会改写穿透类型', after.config.type === 'bore', after.config.type);

  await req('POST', `/api/instances/${iid}/tunnel/rcon/stop`);
  await req('PUT', `/api/instances/${iid}/tunnel`, { ...before.config, type: origType });
}

/** 当前时间片的 TOTP 码;没配密钥就返回 undefined(登录接口会忽略它) */
function totpNow() {
  if (!TOTP_SECRET) return undefined;
  try {
    const totp = require('../src/totp');
    return totp.codeAt(TOTP_SECRET, Math.floor(Date.now() / 1000 / totp.PERIOD));
  } catch {
    return undefined;    // 从面板目录外面跑时拿不到模块,不该因此崩掉
  }
}

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.error(`  ✘ ${name} ${detail}`); }
}

/**
 * 多租户 / 权限边界用例(功能 15)。
 *
 * 原来的冒烟测试全程用一个 admin 会话,所以"普通用户看不见别人的东西"、
 * "配额真的拦得住"、"协作者不能删实例"这些最容易写错、又最要命的路径
 * 一条都没覆盖 —— 恰恰是多租户面板出事的地方。
 *
 * 这里的做法是真开第二个会话:cookie 是模块级的单变量,所以进出都要显式
 * 保存/恢复,不然会把 admin 的会话踩掉,后面的用例全部假失败。
 */
async function multiTenantSuite() {
  const adminCookie = cookie;
  const uname = `smoke_u_${Date.now().toString(36)}`;
  const upass = 'smokepass123';
  let r;

  // 建一个配额很小的普通用户:1 个实例 / 1 GB 内存
  r = await req('POST', '/api/users', {
    username: uname, password: upass, role: 'user',
    limits: { maxInstances: 1, maxMemMB: 1024, maxCpuCores: 1, maxDiskMB: 1024 },
  });
  check('tenant: 建普通用户', r.json && r.json.ok, JSON.stringify(r.json));

  // 邀请链接:签发 → 公开校验 → 不能造管理员 → 一次性
  r = await req('POST', '/api/users/invites', { expiresInHours: 1, note: 'smoke' });
  const invTok = r.json && r.json.token;
  check('invite: 签发', !!invTok);
  if (invTok) {
    const saved = cookie;
    cookie = '';                                   // 未登录状态访问,校验它真的是公开端点
    r = await req('GET', `/api/auth/invite/${invTok}`);
    check('invite: 免登录可校验', r.status === 200 && r.json.ok);
    const invUser = `${uname}_inv`;
    r = await req('POST', `/api/auth/invite/${invTok}`, { username: invUser, password: upass, role: 'admin' });
    check('invite: 兑换成功', r.json && r.json.ok, JSON.stringify(r.json));
    check('invite: 无法自封管理员', r.json && r.json.user && r.json.user.role === 'user',
      r.json && r.json.user && r.json.user.role);
    cookie = '';
    r = await req('POST', `/api/auth/invite/${invTok}`, { username: `${invUser}2`, password: upass });
    check('invite: 一次性(重复兑换被拒)', r.status === 400 && !r.json.ok);
    cookie = saved;
    // 清掉邀请建出来的账号,别在别人的面板里留垃圾
    cookie = adminCookie;
    await req('DELETE', `/api/users/${invUser}`);
    await req('DELETE', `/api/users/invites/${invTok}`);
  }

  // 切到普通用户会话
  cookie = '';
  r = await req('POST', '/api/auth/login', { username: uname, password: upass });
  const tenantOk = r.json && r.json.ok;
  check('tenant: 登录', tenantOk);

  if (tenantOk) {
    // 宿主机信息隔离
    r = await req('GET', '/api/host');
    check('tenant: /api/host 不含宿主机字段',
      r.status === 200 && r.json.hostname === undefined && r.json.cpuModel === undefined,
      JSON.stringify(Object.keys(r.json || {})));
    check('tenant: /api/host 仍给自己的实例计数', r.json && typeof r.json.instanceCount === 'number');

    // 设置里的推送凭据不能外泄
    r = await req('GET', '/api/settings');
    check('tenant: /api/settings 不含 notify 凭据', r.status === 200 && r.json.notify === undefined,
      JSON.stringify(Object.keys(r.json || {})));

    // 管理员专属端点一律 403
    for (const [m, p] of [['GET', '/api/users'], ['GET', '/api/audit'], ['GET', '/api/java'],
                          ['GET', '/api/panel/export'], ['GET', '/api/users/invites/list']]) {
      r = await req(m, p);
      check(`tenant: ${p} → 403`, r.status === 403, String(r.status));
    }

    // 配额:超出内存上限的实例必须被拒
    r = await req('POST', '/api/instances/import', { name: 'smoke-over-quota', xmx: 8192 });
    check('tenant: 超内存配额被拒', !(r.json && r.json.ok) || r.status >= 400,
      JSON.stringify(r.json));
    if (r.json && r.json.ok && r.json.id) await req('DELETE', `/api/instances/${r.json.id}`);

    // 看不见别人的实例
    r = await req('GET', '/api/instances');
    check('tenant: 实例列表已隔离', Array.isArray(r.json) && r.json.every((i) => i.owner === uname),
      JSON.stringify((r.json || []).map((i) => i.owner)));
  }

  // 收尾:恢复 admin 会话并删掉测试用户
  cookie = adminCookie;
  r = await req('DELETE', `/api/users/${uname}`);
  check('tenant: 清理测试用户', r.json && r.json.ok !== false);

  // 面板配置导出:结构完整、含管理员(导入端的护栏就靠这条)
  r = await req('GET', '/api/panel/export');
  check('panel backup: 导出可用', r.status === 200);
  r = await req('POST', '/api/panel/import/preview', { bundle: { format: 'nope' } });
  check('panel backup: 拒绝非备份文件', r.status === 400);
  r = await req('POST', '/api/panel/import/preview', {
    bundle: { format: 'mcsp-panel-backup', formatVersion: 1, data: { 'users.json': [{ username: 'x', role: 'user' }] } },
  });
  check('panel backup: 拒绝无管理员的备份', r.status === 400 && /管理员/.test(r.json.error || ''),
    JSON.stringify(r.json));

  /* 强制 2FA 的自锁防护。跑这段时 admin 通常没配 TOTP,所以开启必须被拒 ——
     这条用例的价值在于它挡的是"点一下就把自己锁在面板外"的不可逆操作。
     如果当前 admin 恰好配了 TOTP,开启会成功,那就换个方向验证并立刻关回去。 */
  r = await req('GET', '/api/auth/me');
  const selfHas2FA = !!(r.json && r.json.user && r.json.user.twoFactor);
  r = await req('PUT', '/api/settings', { require2FA: true });
  if (selfHas2FA) {
    check('2FA policy: 自己有 TOTP 时可开启', r.status === 200 && r.json.settings.require2FA === true);
    // 策略开着时不许关掉自己的 TOTP(通往同一个死锁的另一扇门)
    const d = await req('POST', '/api/auth/2fa/disable', { password: PASS });
    check('2FA policy: 策略开启时禁止关闭自己的 TOTP',
      d.status === 400 && d.json.code === 'policy_2fa_required', JSON.stringify(d.json));
    r = await req('PUT', '/api/settings', { require2FA: false });
    check('2FA policy: 关闭永远放行', r.status === 200 && r.json.settings.require2FA === false);
  } else {
    check('2FA policy: 自己没 TOTP 时禁止开启',
      r.status === 400 && r.json.code === 'self_2fa_required', JSON.stringify(r.json));
    const s = await req('GET', '/api/settings');
    check('2FA policy: 被拒后确实没写进去', s.json.require2FA === false, String(s.json.require2FA));
  }

  /* 异地备份(功能 6)。这里不连真的对象存储 —— 只验配置面的三件事:
     校验拦得住、密钥不回显明文、掩码回传不会把密钥抹掉。
     最后一条尤其要守:用户改个 bucket 就把 secretKey 存成一串圆点的话,
     下次备份会静默传不上去,而页面上看着一切正常。 */
  const rbSaved = (await req('GET', '/api/settings')).json.backupRemote;
  r = await req('POST', '/api/settings/backup-remote/test');
  check('remote backup: 未配置时测试给出原因',
    r.json && r.json.ok === false && !!r.json.error, JSON.stringify(r.json));

  r = await req('PUT', '/api/settings', {
    backupRemote: { enabled: true, type: 's3', endpoint: 'https://s3.example.com',
      bucket: 'b', accessKey: 'AK', secretKey: 'THE-REAL-SECRET', pathStyle: true },
  });
  check('remote backup: 保存后密钥不回显明文',
    r.json.settings.backupRemote.secretKey !== 'THE-REAL-SECRET'
    && r.json.settings.backupRemote.secretKey.length > 0,
    JSON.stringify(r.json.settings.backupRemote.secretKey));
  const mask = r.json.settings.backupRemote.secretKey;

  // 掩码原样回传 = 不修改;此处只改 bucket
  r = await req('PUT', '/api/settings', {
    backupRemote: { enabled: true, type: 's3', endpoint: 'https://s3.example.com',
      bucket: 'b2', accessKey: 'AK', secretKey: mask, pathStyle: true },
  });
  check('remote backup: 掩码回传不覆盖已存密钥', r.json.settings.backupRemote.bucket === 'b2');
  r = await req('POST', '/api/settings/backup-remote/test');
  // 连不上 s3.example.com 是预期的;关键是别报"缺少 secretKey"
  check('remote backup: 密钥仍在(测试报的不是缺字段)',
    r.json.ok === false && !/accessKey|secretKey/.test(r.json.error || ''), JSON.stringify(r.json));

  r = await req('PUT', '/api/settings', { backupRemote: { enabled: true, type: 's3', endpoint: 'not-a-url' } });
  r = await req('POST', '/api/settings/backup-remote/test');
  check('remote backup: 非法 endpoint 被拦',
    r.json.ok === false && /URL/.test(r.json.error || ''), JSON.stringify(r.json));

  // 还原,别把测试配置留在别人的面板上
  await req('PUT', '/api/settings', { backupRemote: { ...rbSaved, enabled: false, secretKey: mask, password: mask } });

  // 阈值校验:越界值必须被夹住而不是写进去
  r = await req('PUT', '/api/settings', { thresholds: { diskWarnPct: 5, crashWindowMin: 99999 } });
  const th = r.json && r.json.settings && r.json.settings.thresholds;
  check('thresholds: 越界值被拒', th && th.diskWarnPct !== 5 && th.crashWindowMin !== 99999,
    JSON.stringify(th));
}

/**
 * 压缩模块的本地往返:不碰面板数据,在临时目录里打包再解回来比对。
 * zip 是我们自己按格式写的,不跑一遍很难发现头字段错位。
 */
async function archiveRoundtrip() {
  const fsp = require('fs/promises');
  const path = require('path');
  const os = require('os');
  const crypto = require('crypto');
  const { archiveKind, createArchive, extractArchive } = require('../src/archive');

  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsp-smoke-'));
  try {
    const src = path.join(root, 'src');
    await fsp.mkdir(path.join(src, '世界/region'), { recursive: true });
    const blob = crypto.randomBytes(200000);                 // 不可压缩,走 deflate 的存储块分支
    await fsp.writeFile(path.join(src, '世界/region/r.0.0.mca'), blob);
    await fsp.writeFile(path.join(src, '世界/level.dat'), 'x'.repeat(30000));
    await fsp.writeFile(path.join(src, 'empty'), '');

    for (const format of ['zip', 'tar.gz']) {
      const out = path.join(root, 'a.' + format);
      const made = await createArchive(out, src, ['世界', 'empty'], format);
      check(`${format} pack`, made.files === 3, JSON.stringify(made));
      check(`${format} detected`, archiveKind(out) === (format === 'zip' ? 'zip' : 'tar'));

      const back = path.join(root, 'back-' + format);
      const got = await extractArchive(out, back, 1073741824);
      check(`${format} unpack`, got.files === 3, JSON.stringify(got));
      check(`${format} content intact`, Buffer.compare(await fsp.readFile(path.join(back, '世界/region/r.0.0.mca')), blob) === 0);
      check(`${format} empty file intact`, (await fsp.stat(path.join(back, 'empty'))).size === 0);
    }

    // zip bomb 闸门:体积上限必须在落盘前就拦下来
    let capped = false;
    try { await extractArchive(path.join(root, 'a.zip'), path.join(root, 'nope'), 1024); }
    catch (e) { capped = /上限/.test(e.message); }
    check('extract size cap', capped);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/* 粘贴时的自动改名。边界都在这儿:复合后缀、已经带 (n) 的、没有后缀的 dotfile。
   不用起服务器,所以放在 HTTP 用例之前先跑。 */
async function uniqueNameRoundtrip() {
  const fsp = require('fs/promises');
  const path = require('path');
  const os = require('os');
  const { reserveUniqueName } = require('../src/routes/instances');

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsp-uniq-'));
  try {
    const take = async (name) => {
      const got = await reserveUniqueName(dir, name);   // 顺带把名字占住,下次调用才会撞
      return got;
    };
    check('uniqueName 首次原样', (await take('a.txt')) === 'a.txt');
    check('uniqueName 撞名加 (2)', (await take('a.txt')) === 'a (2).txt');
    check('uniqueName 接着数 (3)', (await take('a.txt')) === 'a (3).txt');
    // 复合后缀只认最后一段 —— 和多数文件管理器一致
    check('uniqueName 复合后缀', (await take('c.tar.gz')) === 'c.tar.gz');
    check('uniqueName 复合后缀撞名', (await take('c.tar.gz')) === 'c.tar (2).gz');
    // dotfile 没有 stem/ext 之分,不能拆成 " (2).env"
    check('uniqueName dotfile', (await take('.env')) === '.env');
    check('uniqueName dotfile 撞名', (await take('.env')) === '.env (2)');
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

(async () => {
  console.log(`smoke → ${BASE}`);

  await archiveRoundtrip();
  await uniqueNameRoundtrip();

  // 健康检查(免鉴权)
  let r = await req('GET', '/api/health');
  check('health', r.status === 200 && r.json && r.json.ok);

  // 未登录时受保护接口应 401
  cookie = '';
  r = await req('GET', '/api/instances');
  check('unauthorized blocked', r.status === 401);

  // 错误密码应 401
  r = await req('POST', '/api/auth/login', { username: USER, password: 'wrong-password' });
  check('bad login rejected', r.status === 401);

  // 登录。账号开了 2FA 时补一个当前 TOTP 码 —— 没给密钥就如实报错,
  // 别让后面几十条用例都挂在一个"其实是没登上"的原因上
  cookie = '';
  r = await req('POST', '/api/auth/login', { username: USER, password: PASS, code: totpNow() });
  if (r.json && r.json.need2fa && !TOTP_SECRET) {
    console.error('  ✘ login 需要两步验证码:请把 TOTP 密钥作为第 4 个参数传入'
      + '(node scripts/smoke.js <url> <user> <pass> <base32secret>)');
  }
  check('login', r.status === 200 && r.json.ok && !!cookie, JSON.stringify(r.json));
  const isAdmin = r.json && r.json.user && r.json.user.role === 'admin';

  r = await req('GET', '/api/auth/me');
  check('me', r.status === 200 && r.json.ok);

  r = await req('GET', '/api/host');
  check('host', r.status === 200 && typeof r.json.cores === 'number');

  r = await req('GET', '/api/tunnel/components');
  check('tunnel components', r.status === 200 && r.json.ssh);

  r = await req('GET', '/api/instances');
  check('instances list', r.status === 200 && Array.isArray(r.json));
  const inst = r.json && r.json[0];

  if (inst) {
    const iid = inst.id;
    r = await req('GET', `/api/instances/${iid}/status`);
    check('instance status', r.status === 200 && r.json.id === iid);
    check('status exposes autoRestart', typeof r.json.autoRestart === 'boolean', JSON.stringify(r.json.autoRestart));

    r = await req('GET', `/api/instances/${iid}/logs`);
    check('instance logs', r.status === 200 && Array.isArray(r.json));

    r = await req('GET', `/api/instances/${iid}/metrics/history`);
    check('metrics history', r.status === 200 && Array.isArray(r.json));

    r = await req('GET', `/api/instances/${iid}/players`);
    check('players', r.status === 200 && Array.isArray(r.json.online));

    r = await req('GET', `/api/instances/${iid}/files?path=/`);
    check('files list', r.status === 200 && r.json.ok);

    r = await req('GET', `/api/instances/${iid}/files?path=/../../etc`);
    check('path sandbox', r.status === 400);

    r = await req('POST', `/api/instances/${iid}/files/upload?path=/&name=${encodeURIComponent('../pwn.txt')}`);
    check('upload name sandbox', r.status === 400);

    r = await req('POST', `/api/instances/${iid}/files/upload?path=/../../&name=pwn.txt`);
    check('upload path sandbox', r.status === 400);

    r = await req('GET', `/api/instances/${iid}/files/download?path=/../../etc/passwd`);
    check('download path sandbox', r.status === 400);

    r = await req('GET', `/api/instances/${iid}/files/download?path=/`);
    check('download instance root rejected', r.status === 400);

    r = await req('POST', `/api/instances/${iid}/files/rename`, { path: '/server.properties', name: '../pwn' });
    check('rename name sandbox', r.status === 400);

    r = await req('POST', `/api/instances/${iid}/files/extract`, { path: '/../../etc/x.zip' });
    check('extract source sandbox', r.status === 400);

    r = await req('POST', `/api/instances/${iid}/files/extract`, { path: '/server.properties' });
    check('extract rejects non-archive', r.status === 400);

    r = await req('POST', `/api/instances/${iid}/files/archive`, { dir: '/', names: ['../../etc'], format: 'zip' });
    check('archive name sandbox', r.status === 400);

    r = await req('POST', `/api/instances/${iid}/files/archive`, { dir: '/', names: [], format: 'zip' });
    check('archive empty selection rejected', r.status === 400);

    /* 移动 / 复制:两侧路径都要校验,名字要逐个校验 */
    const xfer = (b) => req('POST', `/api/instances/${iid}/files/transfer`, b);

    r = await xfer({ op: 'move', from: '/', names: ['../etc'], to: '/' });
    check('transfer name sandbox', r.status === 400);

    r = await xfer({ op: 'move', from: '/../../etc', names: ['x'], to: '/' });
    check('transfer source sandbox', r.status === 400);

    r = await xfer({ op: 'copy', from: '/', names: ['x'], to: '/../../tmp' });
    check('transfer dest sandbox', r.status === 400);

    /* 目录不能放进自己里面。这条是纯词法判断且排在存在性检查之前,
       所以无论实例里有没有 world 目录都稳定返回 400 */
    r = await xfer({ op: 'move', from: '/', names: ['world'], to: '/world/sub' });
    check('transfer self-descendant guard', r.status === 400);

    /* 同前缀目录不能被误伤:'/a/worldsave'.startsWith('/a/world') 是 true */
    r = await xfer({ op: 'move', from: '/', names: ['world'], to: '/world_nether' });
    check('transfer sibling prefix allowed', r.status !== 400);

    r = await xfer({ op: 'chmod', from: '/', names: ['a'], to: '/' });
    check('transfer bad op rejected', r.status === 400);

    r = await xfer({ op: 'move', from: '/', names: [], to: '/' });
    check('transfer empty selection rejected', r.status === 400);

    r = await xfer({ op: 'move', from: '/', names: new Array(501).fill('a'), to: '/' });
    check('transfer batch cap', r.status === 400);

    r = await req('DELETE', `/api/instances/${iid}/files/batch`, { dir: '/', names: ['../../etc'] });
    check('batch delete name sandbox', r.status === 400);

    r = await req('DELETE', `/api/instances/${iid}/files/batch`, { dir: '/../../etc', names: ['passwd'] });
    check('batch delete dir sandbox', r.status === 400);

    r = await req('DELETE', `/api/instances/${iid}/files/batch`, { dir: '/', names: [] });
    check('batch delete empty selection rejected', r.status === 400);

    r = await req('GET', `/api/instances/${iid}/properties`);
    check('properties', r.status === 200 && typeof r.json === 'object');

    r = await req('GET', `/api/instances/${iid}/backups`);
    check('backups list', r.status === 200 && Array.isArray(r.json));

    r = await req('GET', `/api/instances/${iid}/backups/${encodeURIComponent('../../../etc/passwd.tar.gz')}/download`);
    check('backup id sandbox', r.status === 404);

    r = await req('GET', `/api/instances/${iid}/tasks`);
    check('tasks list', r.status === 200 && Array.isArray(r.json));

    r = await req('GET', `/api/instances/${iid}/tunnel`);
    check('tunnel config', r.status === 200 && r.json.ok);

    r = await req('GET', `/api/instances/${iid}/worlds`);
    check('worlds', r.status === 200 && Array.isArray(r.json));
  } else {
    console.log('  (无实例,跳过实例级用例)');
  }

  if (isAdmin) {
    r = await req('GET', '/api/users');
    check('users list (admin)', r.status === 200 && Array.isArray(r.json));
  }

  r = await req('GET', '/api/instances/not-exist/status');
  check('404 instance', r.status === 404);

  if (inst) await incrementalBackupSuite(inst.id);
  if (inst) await rconTunnelSuite(inst.id);
  if (inst && isAdmin) await collabRoleSuite(inst.id);

  /* ── 多租户与新功能的集成用例(功能 15)──
     这一段专门覆盖"跨用户"和"权限边界",单用户的 happy path 测不到这些。
     全部在 admin 会话下建资源、切到普通用户会话验证隔离,最后清理干净。 */
  if (isAdmin) await multiTenantSuite();

  // 畸形 JSON 应该是 400(客户端错),不是 500
  {
    const res = await fetch(BASE + '/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: '{"broken":',
    });
    check('malformed JSON → 400', res.status === 400, String(res.status));
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
