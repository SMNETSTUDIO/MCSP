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

(async () => {
  console.log(`smoke → ${BASE}`);

  await archiveRoundtrip();

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
