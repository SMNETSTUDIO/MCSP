/** Express 装配:中间件、路由、SSE、静态页、错误兜底、优雅退出 */
const express = require('express');
const path = require('path');
const { PORT, PUBLIC_DIR, PANEL_STARTED } = require('./config');
const auth = require('./auth');
const bus = require('./bus');
const registry = require('./registry');
const tasks = require('./tasks');

const app = express();
// 反代友好:信任第一跳代理(CF/nginx 的 X-Forwarded-*),
// req.protocol/req.ip 才正确 —— 影响 OAuth 回调地址推导与登录限速的 IP 判定
app.set('trust proxy', 1);
app.use(express.json());

/* 健康检查(免鉴权,供探针/监控使用) */
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: require('../package.json').version,
    uptime: Date.now() - PANEL_STARTED,
    instances: registry.instances.size,
  });
});

/* 审计:所有写操作都记一笔。挂在最前面,连登录尝试(含失败的)一起记 —— 
   排查"谁在暴力试密码"时那正是要看的东西 */
app.use('/api', require('./audit').middleware);

/* 认证路由(login/logout/me/password) */
app.use('/api/auth', auth.router);

/* 自定义 OAuth 登录(status/login/bind/callback 公开;配置接口在下方需管理员) */
app.use('/api/auth/oauth', require('./oauth').router);

/* 其余 /api 全部需要会话 */
app.use('/api', auth.requireAuth);

/* 强制两步验证:开了之后,没配 TOTP 的账号只放行 /api/auth/*。
   必须排在所有业务路由前面,否则就成了摆设 */
app.use('/api', auth.requireTwoFactor);

app.use('/api/oauth', require('./oauth').adminRouter);
app.use('/api/settings', require('./settings').router);   // 系统设置:注册开关、公告
app.use('/api/panel', require('./panelbackup').router);   // 面板配置导出/导入

app.use('/api/users', require('./routes/users').router);

/* 审计日志查询(仅管理员) */
app.get('/api/audit', auth.requireAdmin, (req, res) => {
  res.json({ ok: true, ...require('./audit').read(req.query) });
});

app.use('/api', require('./routes/host'));           // /api/host, /api/paper/versions
app.use('/api/tunnel', require('./routes/tunnel'));  // 组件安装
app.use('/api/instances', require('./routes/instances'));

/* SSE 实时流 */
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // 告知 nginx 等反代不要缓冲 SSE 流

  });
  res.mcspUser = { username: req.user.username, role: req.user.role };   // SSE 按归属过滤
  for (const inst of registry.instances.values()) {
    if (!inst.canAccess(req.user)) continue;
    res.write(`event: state\ndata: ${JSON.stringify(inst.snapshot())}\n\n`);
  }
  bus.subscribers.add(res);
  const ping = setInterval(() => res.write(': ping\n\n'), 25000);
  req.on('close', () => {
    clearInterval(ping);
    bus.subscribers.delete(res);
  });
});

/* 静态页:未登录访问面板跳登录,已登录访问登录页跳面板;URL 不暴露 .html 后缀 */
app.get('/', (req, res, next) => {
  if (!auth.getSession(req)) return res.redirect('/login');
  next();
});
app.get('/login', (req, res) => {
  if (auth.getSession(req)) return res.redirect('/');
  res.sendFile(path.join(PUBLIC_DIR, 'login.html'), { headers: { 'Cache-Control': 'no-cache' } });
});
/* 旧的 .html 地址 301 到无后缀版本(兼容书签) */
/* 邀请注册页:免登录,页面自己拿 URL 里的 token 去校验 */
app.get('/invite/:token', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'invite.html'), { headers: { 'Cache-Control': 'no-cache' } });
});
app.get('/login.html', (req, res) => res.redirect(301, '/login'));
app.get('/index.html', (req, res) => res.redirect(301, '/'));
app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    // HTML/JS/CSS 走协商缓存(ETag 304 很便宜):面板更新后浏览器不会拿旧脚本,
    // 否则新增的按钮/监听器在用户强刷前都是"点了没反应"
    if (/\.(html|js|css)$/.test(filePath)) res.setHeader('Cache-Control', 'no-cache');
    else res.setHeader('Cache-Control', 'public, max-age=604800');   // 字体等长缓存
  },
}));

/* 全局错误兜底:异步路由抛错返回 JSON 而不是打崩进程。
   express.json 对畸形 body 抛的错自带 status 400 —— 别一律当 500 报,
   那会把"你的请求体不合法"说成"服务器坏了"。 */
app.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error('[MCSP] 未捕获的路由错误:', err);
  if (res.headersSent) return;
  res.status(status).json({
    ok: false,
    error: status === 400 ? `请求体格式错误: ${err.message}` : `服务器内部错误: ${err.message}`,
  });
});

/* 优雅退出:先让所有子服 save-all 落盘 */
function shutdown() {
  // 必须先置位:否则子进程一个个退出时会被当成崩溃,面板正关着还在往回拉服
  require('./instance').panel.shuttingDown = true;
  for (const inst of registry.instances.values()) {
    inst.cancelAutoRestart();
    if (inst.tunnelProc) { try { inst.tunnelProc.kill('SIGTERM'); } catch {} }
    if (inst.proc) {
      try { inst.proc.stdin.write(inst.stopCmd + '\n'); } catch {}
    }
  }
  setTimeout(() => process.exit(0), 8000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function start() {
  registry.loadRegistry();
  registry.startMetricsLoop();
  require('./disk').startDiskLoop();
  tasks.startScheduler();
  app.listen(PORT, () => {
    console.log(`MCSP panel running at http://localhost:${PORT}`);
    // 端口起来之后再恢复实例:恢复要几十秒,不该把面板本身堵在后面
    registry.resumeInstances();
  });
}

module.exports = { app, start };
