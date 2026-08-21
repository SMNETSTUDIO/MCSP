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

(async () => {
  console.log(`smoke → ${BASE}`);

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

    r = await req('GET', `/api/instances/${iid}/properties`);
    check('properties', r.status === 200 && typeof r.json === 'object');

    r = await req('GET', `/api/instances/${iid}/backups`);
    check('backups list', r.status === 200 && Array.isArray(r.json));

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

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('smoke crashed:', e); process.exit(1); });
