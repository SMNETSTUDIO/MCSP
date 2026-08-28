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

async function req(method, path, body, extraHeaders) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(extraHeaders || {}),      // 模拟浏览器的 Origin / Sec-Fetch-Site,测 CSRF 用
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/** 等实例离开 installing 状态(装服务端是异步的),最多等 15 秒 */
async function waitSettled(iid, timeoutMs = 15000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const r = await req('GET', `/api/instances/${iid}/status`);
    if (!r.json || r.json.state !== 'installing') return r.json && r.json.state;
    await new Promise((x) => setTimeout(x, 200));
  }
  return 'installing';   // 超时就照原样跑,让用例自己报出真实问题
}

/** 分片上传要发裸字节,借不到上面那个只会 JSON 的 req() */
async function reqRaw(method, path, buf) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/octet-stream', ...(cookie ? { Cookie: cookie } : {}) },
    body: buf,
    redirect: 'manual',
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

/**
 * 分片上传(绕开反代 ~10MB 请求体墙的那套 init → chunk ×N → finish)。
 *
 * 重点不是"能不能传上去",而是两件容易静默出错的事:
 *   · 分片乱序并发写偏移 —— 顺序写永远碰不出偏移算错的 bug;
 *   · 缺片 / 短片 —— 这两种情况会合出一个中间带零洞的文件,大小还是对的,
 *     只有把内容读回来逐字节比对才发现。
 */
async function chunkedUploadSuite(iid) {
  let r = await req('POST', `/api/instances/${iid}/files/upload/init`, { path: '/', name: '../pwn.txt', size: 10 });
  check('chunk init: 文件名沙箱', r.status === 400);

  r = await req('POST', `/api/instances/${iid}/files/upload/init`, { path: '/../../', name: 'pwn.txt', size: 10 });
  check('chunk init: 路径沙箱', r.status === 400);

  r = await req('POST', `/api/instances/${iid}/files/upload/init`, { path: '/', name: 'huge.bin', size: 1024 ** 4 });
  check('chunk init: 声明体积超上限即拒', r.status === 413, JSON.stringify(r.json));

  r = await req('POST', `/api/instances/${iid}/files/upload/init`, { path: '/', name: 'zero.bin', size: 0 });
  check('chunk init: 拒绝 0 字节', r.status === 400);

  // uploadId 是能力凭证:格式不对 / 不存在的一律挡掉,且不区分"不存在"和"不是你的"
  r = await reqRaw('POST', `/api/instances/${iid}/files/upload/chunk?uploadId=../../etc&index=0`, Buffer.alloc(4));
  check('chunk: uploadId 格式校验', r.status === 400);

  const zeros = '0'.repeat(32);
  r = await reqRaw('POST', `/api/instances/${iid}/files/upload/chunk?uploadId=${zeros}&index=0`, Buffer.alloc(4));
  check('chunk: 未知会话 404', r.status === 404);

  r = await req('POST', `/api/instances/${iid}/files/upload/finish`, { uploadId: zeros });
  check('finish: 未知会话 404', r.status === 404);

  r = await req('POST', `/api/instances/${iid}/files/upload/abort`, { uploadId: zeros });
  check('abort: 幂等(未知会话也返回 ok)', r.status === 200 && r.json.ok);

  /* 端到端:三片乱序并发发出,合出来的文件必须逐字节正确。
     末片故意取成余数,顺带验证"最后一片短"这条路 */
  r = await req('GET', '/api/auth/me');
  check('me: 下发上传参数', !!(r.json && r.json.upload && r.json.upload.chunkMB > 0), JSON.stringify(r.json && r.json.upload));
  const CH = ((r.json && r.json.upload && r.json.upload.chunkMB) || 5) * 1048576;
  const parts = [Buffer.alloc(CH, 0x41), Buffer.alloc(CH, 0x42), Buffer.alloc(7, 0x43)];
  const total = CH * 2 + 7;

  r = await req('POST', `/api/instances/${iid}/files/upload/init`,
    { path: '/', name: 'smoke-chunk.bin', size: total, overwrite: true });
  const uid = r.json && r.json.uploadId;
  check('chunk init: 拿到 uploadId', r.status === 200 && /^[0-9a-f]{32}$/.test(uid || ''), JSON.stringify(r.json));
  check('chunk init: chunkSize 由服务端说了算', r.json && r.json.chunkSize === CH && r.json.chunks === 3,
    JSON.stringify(r.json && { chunkSize: r.json.chunkSize, chunks: r.json.chunks }));

  if (uid) {
    const rs = await Promise.all([2, 0, 1].map((i) =>
      reqRaw('POST', `/api/instances/${iid}/files/upload/chunk?uploadId=${uid}&index=${i}`, parts[i])));
    check('chunk: 三片乱序并发全部收下', rs.every((x) => x.status === 200 && x.json.ok),
      JSON.stringify(rs.map((x) => x.status)));

    // 越界序号 / 短片都得挡住,不能让零洞混进去
    r = await reqRaw('POST', `/api/instances/${iid}/files/upload/chunk?uploadId=${uid}&index=99`, Buffer.alloc(4));
    check('chunk: 序号越界被拒', r.status === 400);

    r = await req('POST', `/api/instances/${iid}/files/upload/finish`, { uploadId: uid });
    check('finish: 合并成功且体积正确', r.status === 200 && r.json.ok && r.json.size === total, JSON.stringify(r.json));

    const dl = await fetch(`${BASE}/api/instances/${iid}/files/download?path=/smoke-chunk.bin`,
      { headers: { Cookie: cookie } });
    const got = Buffer.from(await dl.arrayBuffer());
    check('finish: 内容逐字节正确(偏移没写错)',
      got.length === total && got[0] === 0x41 && got[CH - 1] === 0x41
      && got[CH] === 0x42 && got[CH * 2 - 1] === 0x42
      && got[CH * 2] === 0x43 && got[total - 1] === 0x43,
      `len=${got.length} 期望=${total}`);

    r = await req('POST', `/api/instances/${iid}/files/upload/finish`, { uploadId: uid });
    check('finish: 同一会话不能重复合并', r.status === 404, JSON.stringify(r.json));

    await req('DELETE', `/api/instances/${iid}/files?path=%2Fsmoke-chunk.bin`);
  }

  /* 缺片就 finish:必须拒。放过去的话 rename 出来的是个中间带零洞的文件,
     体积、名字都对,用户要到启动服务器时才发现存档是坏的 */
  r = await req('POST', `/api/instances/${iid}/files/upload/init`,
    { path: '/', name: 'smoke-partial.bin', size: CH * 2, overwrite: true });
  const uid2 = r.json && r.json.uploadId;
  if (uid2) {
    await reqRaw('POST', `/api/instances/${iid}/files/upload/chunk?uploadId=${uid2}&index=0`, Buffer.alloc(CH, 1));
    r = await req('POST', `/api/instances/${iid}/files/upload/finish`, { uploadId: uid2 });
    check('finish: 缺片被拒', r.status === 409, JSON.stringify(r.json));

    r = await req('POST', `/api/instances/${iid}/files/upload/abort`, { uploadId: uid2 });
    check('abort: 返回 ok', r.status === 200 && r.json.ok);

    r = await req('GET', `/api/instances/${iid}/files?path=/`);
    const names = (r.json && (r.json.entries || r.json)) || [];
    check('abort: 目录里不留半截文件',
      Array.isArray(names) && !names.some((e) => e && e.name === 'smoke-partial.bin'));
  }
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
  /* 启停的真实路由是 /server/:action。OPERATOR_WRITES 原先写的是 /^\/(start|…)$/,
     永不匹配,启停于是被判成 manager —— operator 档形同虚设,想给人启停权就只能
     给 manager(而 manager 能改文件改配置)。不是 200 就是没走到业务逻辑:
     这里只要求"不是 403",实例没装完 start 返回失败也算通过。 */
  check('collab operator: 可启停(路由是 /server/:action,别再写成 /start)',
    (await as(users.operator, 'POST', '/server/stop')) !== 403);

  // viewer 不该读到凭据:这几条 GET 会吐出 rcon 密码 / 整个 server.properties / 任意文件
  check('collab viewer: 禁止读 rcon 密码', (await as(users.viewer, 'GET', '/rcon')) === 403);
  check('collab viewer: 禁止读 server.properties', (await as(users.viewer, 'GET', '/properties')) === 403);
  check('collab viewer: 禁止读任意文件内容',
    (await as(users.viewer, 'GET', '/files/content?path=%2Fserver.properties')) === 403);
  check('collab viewer: 仍读得到日志(没有误伤只读本职)',
    (await as(users.viewer, 'GET', '/logs')) === 200);

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
 * 把一个 import 空壳走完 finalize,让它变成 stopped —— 否则删不掉。
 *
 * `DELETE /:iid` 要求 `state === 'stopped'`,而空壳是 `importing`,唯一的出路就是
 * finalize。用例里凡是建了空壳的,收尾都得先过这一道,不然实例留在注册表里,
 * 后面「删测试用户」会因为"该用户还有实例"失败,看起来像是权限用例挂了。
 */
async function finalizeImportShell(iid) {
  const fsp = require('fs/promises');
  const path = require('path');
  const os = require('os');
  const { createArchive } = require('../src/archive');
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsp-shell-'));
  try {
    const src = path.join(root, 'srv');
    await fsp.mkdir(src, { recursive: true });
    await fsp.writeFile(path.join(src, 'server.properties'), 'server-port=25598\nlevel-name=world\n');
    await fsp.writeFile(path.join(src, 'server.jar'), Buffer.alloc(1024, 7));
    const zip = path.join(root, 'srv.zip');
    await createArchive(zip, src, await fsp.readdir(src), 'zip');
    await reqRaw('POST', `/api/instances/${iid}/files/upload?path=%2F&name=srv.zip&overwrite=1`,
      await fsp.readFile(zip));
    await req('POST', `/api/instances/${iid}/import/finalize`, { archive: '/srv.zip', eula: true });
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
  }
}

/**
 * 安全边界:CSRF、SSRF、凭据回显。
 *
 * 这三样都是"不做也能正常跑"的东西 —— 正因如此才要有用例钉住,
 * 否则哪天有人为了省事把校验去掉,功能测试一条都不会红。
 */
async function securitySuite() {
  const MASK = '••••••••';
  let r;

  /* ── CSRF ──
     面板全靠 Cookie 会话,而 Cookie 是浏览器自动附带的。没有这道校验,
     任何网页都能在管理员登录着的时候对面板发 POST。 */
  r = await req('PUT', '/api/settings', { announcement: 'csrf-probe' }, { 'Sec-Fetch-Site': 'cross-site' });
  check('csrf: 跨站请求被拒(Sec-Fetch-Site)', r.status === 403 && r.json && r.json.code === 'csrf',
    `${r.status} ${JSON.stringify(r.json)}`);

  r = await req('PUT', '/api/settings', { announcement: 'csrf-probe' }, { Origin: 'https://evil.example.com' });
  check('csrf: 伪造 Origin 被拒', r.status === 403, `${r.status} ${JSON.stringify(r.json)}`);

  r = await req('PUT', '/api/settings', { announcement: '' }, { 'Sec-Fetch-Site': 'same-origin' });
  check('csrf: 同源请求放行(没误伤正常前端)', r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);

  r = await req('GET', '/api/host', undefined, { 'Sec-Fetch-Site': 'cross-site' });
  check('csrf: GET 不受影响(只拦状态变更)', r.status === 200, String(r.status));

  /* ── SSRF ──
     "测试推送"会把每个通道的错误回显,不挡内网的话它就是个带回显的端口探测器。 */
  for (const [label, url] of [
    ['环回', 'http://127.0.0.1:25575/x'],
    ['云元数据', 'http://169.254.169.254/latest/meta-data/'],
    ['内网段', 'http://10.0.0.5/hook'],
  ]) {
    r = await req('POST', '/api/settings/notify/test', {
      notify: { enabled: true, webhookUrl: url, discordUrl: '', telegramToken: '', telegramChatId: '' },
    });
    const results = (r.json && r.json.results) || [];
    const blocked = results.some((x) => !x.ok && /内网|环回|localhost|拒绝/.test(x.error || ''));
    check(`ssrf: ${label}地址被拒(${url.slice(0, 32)}…)`, blocked, JSON.stringify(results));
  }

  /* ── 凭据回显 ──
     backupRemote 早就掩码了,notify 里的 webhook / bot token 之前是明文返回的。 */
  await req('PUT', '/api/settings', {
    notify: {
      enabled: false, webhookUrl: 'https://example.com/hook?token=s3cr3t',
      discordUrl: '', telegramToken: 'bot-token-should-not-echo', telegramChatId: '123',
    },
  });
  r = await req('GET', '/api/settings');
  const n = (r.json && r.json.notify) || {};
  check('mask: telegramToken 不明文回显', n.telegramToken === MASK, JSON.stringify(n.telegramToken));
  check('mask: webhookUrl 不明文回显', n.webhookUrl === MASK, JSON.stringify(n.webhookUrl));

  // 掩码原样传回来不能把真值抹掉,否则改个 chatId 就会把 token 洗成一串圆点
  await req('PUT', '/api/settings', {
    notify: { enabled: false, webhookUrl: MASK, discordUrl: '', telegramToken: MASK, telegramChatId: '456' },
  });
  r = await req('POST', '/api/settings/notify/test', {
    notify: { enabled: true, webhookUrl: MASK, discordUrl: '', telegramToken: '', telegramChatId: '' },
  });
  const msg = JSON.stringify((r.json && r.json.results) || []);
  check('mask: 掩码回传后真值仍在(报错不是"不是合法 URL")', !/不是合法 URL/.test(msg), msg);

  // 收尾:把 notify 清空,别给下次运行留状态
  await req('PUT', '/api/settings', {
    notify: { enabled: false, webhookUrl: '', discordUrl: '', telegramToken: '', telegramChatId: '' },
  });

  /* 中途放弃的导入空壳要能删掉。它的 state 是 importing,唯一出路 finalize
     需要一个有效压缩包 —— 原先 DELETE 只放行 stopped,于是这个空壳既用不了也删不掉,
     只能靠"重启面板让 state 变回 stopped"这种非显然的办法脱身。 */
  r = await req('POST', '/api/instances/import', { name: 'smoke-abandoned', xmx: 512 });
  const aid = r.json && r.json.instance && r.json.instance.id;
  check('import: 建空壳', !!aid && r.json.instance.state === 'importing', JSON.stringify(r.json));
  if (aid) {
    r = await req('DELETE', `/api/instances/${aid}`);
    check('import: 放弃的空壳可以直接删(不必重启面板)',
      r.status === 200 && r.json && r.json.ok, `${r.status} ${JSON.stringify(r.json)}`);
  }
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

    /* 内存配额按「堆 + 堆外」计。配额 1024 MB,默认余量 max(512 MB, 13%):
       1024 的实例实占 1536 装不下,512 的实例实占 1024 正好占满。
       这两条一起把边界钉死 —— 只测"被拒"的话,余量算成多大都能过。 */
    r = await req('POST', '/api/instances/import', { name: 'smoke-mem-1024', xmx: 1024 });
    check('quota: 1024 实例被堆外余量拦下(配额 1024)',
      r.status >= 400 && !(r.json && r.json.ok), `${r.status} ${JSON.stringify(r.json)}`);
    check('quota: 拒绝文案点明堆外(否则用户会以为面板算错了)',
      !!(r.json && /堆外/.test(r.json.error || '')), r.json && r.json.error);
    if (r.json && r.json.ok && r.json.instance) await req('DELETE', `/api/instances/${r.json.instance.id}`);

    r = await req('POST', '/api/instances/import', { name: 'smoke-mem-512', xmx: 512 });
    const memIid = r.json && r.json.instance && r.json.instance.id;
    check('quota: 512 实例恰好占满配额(512 堆 + 512 堆外 = 1024)',
      r.status === 200 && !!memIid, `${r.status} ${JSON.stringify(r.json)}`);

    if (memIid) {
      /* 存量超额的锁死回归。制造局面:先放宽配额把实例撑到 2048,再把配额收回 1024。
         此时实例实占 2560 > 配额 1024,和"管理员调低了配额"或"升级后口径变严"
         是同一种状态。前端保存实例设置时**总会**带上 xmx,所以挡住持平
         = 用户连改个实例名都做不了,而"把内存调小自救"恰好被同一条拦住。 */
      const tenantCookie = cookie;
      const setQuota = async (memMB) => {
        cookie = adminCookie;
        await req('PUT', `/api/users/${uname}/limits`,
          { maxInstances: 1, maxMemMB: memMB, maxCpuCores: 1, maxDiskMB: 1024 });
        cookie = tenantCookie;
      };

      await setQuota(4096);
      r = await req('PATCH', `/api/instances/${memIid}`, { xmx: 2048 });
      check('quota: 配额够时可以加内存', r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);

      await setQuota(1024);   // ← 实例 2048(实占 2560)现在远超配额
      r = await req('PATCH', `/api/instances/${memIid}`, { xmx: 2048, name: 'smoke-mem-renamed' });
      check('quota: 超额时持平的 PATCH 放行(否则连改名都做不了)',
        r.status === 200, `${r.status} ${JSON.stringify(r.json)}`);

      r = await req('PATCH', `/api/instances/${memIid}`, { xmx: 1024 });
      check('quota: 超额时缩小放行(这是唯一的自救出路)',
        r.status === 200 && r.json && r.json.instance && r.json.instance.xmx === 1024,
        `${r.status} ${JSON.stringify(r.json)}`);

      r = await req('PATCH', `/api/instances/${memIid}`, { xmx: 4096 });
      check('quota: 超额时继续加内存仍被拒', r.status === 403, `${r.status} ${JSON.stringify(r.json)}`);

      // 空壳是 importing,直接 DELETE 会被 state 守卫挡掉 —— 先 finalize 再删
      await finalizeImportShell(memIid);
      r = await req('DELETE', `/api/instances/${memIid}`);
      check('quota: 清理测试实例', r.status === 200 && r.json && r.json.ok,
        `${r.status} ${JSON.stringify(r.json)}`);
    }

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
/**
 * 导入已有服务器的完整三步:建空壳 → 传包 → finalize 解压识别。
 *
 * 加这条是因为它整个坏过而没人发现:POST /import 注册在 router.use('/:iid')
 * 之后,被当成一个叫 "import" 的实例 ID 查,恒返回 404。功能全废,却只是个
 * 404、不报错,而冒烟里当时**一条都没覆盖导入流程**。
 */
async function importFlowRoundtrip() {
  const fsp = require('fs/promises');
  const path = require('path');
  const os = require('os');
  const { createArchive } = require('../src/archive');

  // 第一步就是当初挂掉的地方:先确认它不再 404
  let r = await req('POST', '/api/instances/import', { name: 'smoke-导入', xmx: 1024 });
  check('import: 建空壳实例(不再被 /:iid 吞掉)',
    r.status === 200 && r.json && r.json.ok && r.json.instance && r.json.instance.id,
    `${r.status} ${JSON.stringify(r.json)}`);
  const iid = r.json && r.json.instance && r.json.instance.id;
  if (!iid) return;

  check('import: 空壳状态是 importing', r.json.instance.state === 'importing', r.json.instance.state);

  // 造一个像模像样的服务端包:server.properties + 一个 jar
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'mcsp-import-'));
  try {
    const src = path.join(root, 'srv');
    await fsp.mkdir(src, { recursive: true });
    await fsp.writeFile(path.join(src, 'server.properties'), 'server-port=25599\nlevel-name=world\n');
    await fsp.writeFile(path.join(src, 'server.jar'), Buffer.alloc(2048, 7));
    const zip = path.join(root, 'srv.zip');
    await createArchive(zip, src, await fsp.readdir(src), 'zip');

    const buf = await fsp.readFile(zip);
    r = await reqRaw('POST', `/api/instances/${iid}/files/upload?path=%2F&name=srv.zip&overwrite=1`, buf);
    check('import: 压缩包上传成功', r.status === 200 && r.json && r.json.ok, JSON.stringify(r.json));

    r = await req('POST', `/api/instances/${iid}/import/finalize`, { archive: '/srv.zip', eula: true });
    check('import: finalize 解压并识别', r.status === 200 && r.json && r.json.ok, JSON.stringify(r.json));

    r = await req('GET', `/api/instances/${iid}/files?path=/`);
    const names = ((r.json && r.json.entries) || []).map((e) => e.name);
    check('import: 包内容已就位', names.includes('server.properties') && names.includes('server.jar'), names.join(','));
    check('import: 压缩包本身已清掉', !names.includes('srv.zip'), names.join(','));

    r = await req('GET', `/api/instances/${iid}/status`);
    check('import: 导完不再是 importing', r.json && r.json.state !== 'importing', r.json && r.json.state);
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    await req('DELETE', `/api/instances/${iid}`);
  }
}

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

  /* 刚建出来的实例会经历 stopped → installing → stopped(装服务端是异步的,
     约几百毫秒)。撞在 installing 这一小段里跑用例,恢复备份那条会被
     "请先停止实例再恢复备份" 挡下,报成一个跟它本意无关的假失败 ——
     这就是偶发的 "133 passed, 1 failed"。先等它落定再往下走。 */
  if (inst) await waitSettled(inst.id);

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

  await importFlowRoundtrip();          // 自己建实例,不依赖 inst;但要登录后才能跑
  if (inst) await incrementalBackupSuite(inst.id);
  if (inst) await chunkedUploadSuite(inst.id);
  if (inst) await rconTunnelSuite(inst.id);
  if (inst && isAdmin) await collabRoleSuite(inst.id);

  /* ── 多租户与新功能的集成用例(功能 15)──
     这一段专门覆盖"跨用户"和"权限边界",单用户的 happy path 测不到这些。
     全部在 admin 会话下建资源、切到普通用户会话验证隔离,最后清理干净。 */
  if (isAdmin) await multiTenantSuite();

  if (isAdmin) await securitySuite();

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
