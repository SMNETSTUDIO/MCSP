#!/usr/bin/env node
/**
 * 冒烟测试:对运行中的面板做一轮真实 API 回归。
 * 用法: node scripts/smoke.js [baseUrl] [username] [password]
 * 默认: http://localhost:3000 admin admin123
 */
const BASE = process.argv[2] || 'http://localhost:3000';
const USER = process.argv[3] || 'admin';
const PASS = process.argv[4] || 'admin123';

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

  // 登录
  cookie = '';
  r = await req('POST', '/api/auth/login', { username: USER, password: PASS });
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
