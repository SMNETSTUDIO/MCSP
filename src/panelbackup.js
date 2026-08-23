/**
 * 面板自身配置的导出 / 导入(功能 11)。
 *
 * 备份的是"面板怎么配的",不是"服务器里有什么" —— 世界和插件归实例备份管
 * (backups.js),这里只打包 data/ 下那几个 JSON:换机器、重装系统、
 * 或者手滑把 users.json 删了的时候用。
 *
 * 刻意不包含的东西:
 *   · sessions.json / login-attempts.json —— 一次性状态,导过去只会让人带着
 *     别的机器的登录态,反而危险
 *   · audit.log —— 可能几十 MB,而且它是"这台机器上发生过什么"的账本,
 *     跟着配置搬家没有意义
 *   · instances/ 与 backups/ 的实际内容 —— 那是 GB 级的东西,不该塞进一个
 *     点一下就下载的 JSON 里。instances.json 里的元数据会带上,导入后
 *     实例会以"目录不存在"的状态出现,把目录拷过去就能接上。
 *
 * users.json 里有 scrypt 口令哈希、TOTP 密钥和 API Token 摘要。这是恢复
 * 账号体系必需的,但也意味着导出文件等同于凭据库 —— 接口仅管理员可用,
 * 响应头明确标成 attachment,前端也会当面提示。
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const { DATA_DIR } = require('./config');
const { readJson } = require('./utils');
const { requireAdmin } = require('./auth');
const { version: PANEL_VERSION } = require('../package.json');

/* 参与导入导出的文件。value 是缺省值,决定了文件不存在时导出成什么 */
const FILES = {
  'settings.json': {},
  'users.json': [],
  'instances.json': [],
  'tasks.json': [],
  'oauth.json': {},
};

const FORMAT = 'mcsp-panel-backup';
const FORMAT_VERSION = 1;

function buildBundle() {
  const data = {};
  for (const [name, fallback] of Object.entries(FILES)) {
    data[name] = readJson(path.join(DATA_DIR, name), fallback);
  }
  return {
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    panelVersion: PANEL_VERSION,
    exportedAt: Date.now(),
    data,
  };
}

/**
 * 校验上传的包。宁可啰嗦也要在动任何文件之前全部查完 ——
 * 写到一半发现格式不对,面板就处在半新半旧的状态了。
 */
function validateBundle(bundle) {
  if (!bundle || typeof bundle !== 'object') return '不是合法的 JSON 对象';
  if (bundle.format !== FORMAT) return `不是面板配置备份文件(format=${bundle.format || '缺失'})`;
  if (bundle.formatVersion > FORMAT_VERSION) {
    return `备份来自更新版本的面板(格式 v${bundle.formatVersion}),当前面板只认到 v${FORMAT_VERSION}`;
  }
  if (!bundle.data || typeof bundle.data !== 'object') return '备份缺少 data 段';
  const users = bundle.data['users.json'];
  if (!Array.isArray(users) || !users.length) return '备份里没有任何用户,导入会把自己锁在门外';
  if (!users.some((u) => u && u.role === 'admin')) return '备份里没有管理员账号,导入会失去面板控制权';
  for (const [name, fallback] of Object.entries(FILES)) {
    if (!(name in bundle.data)) continue;
    const got = bundle.data[name];
    const wantArray = Array.isArray(fallback);
    if (wantArray !== Array.isArray(got) || typeof got !== 'object' || got === null) {
      return `${name} 的类型不对(应为 ${wantArray ? '数组' : '对象'})`;
    }
  }
  return null;
}

/**
 * 落盘。先把现有文件另存为 .bak-<时间戳>,再写新的 ——
 * 导入是"用别的机器的配置盖掉这台",出错时得能手动退回去。
 */
function applyBundle(bundle) {
  const stamp = new Date(bundle.exportedAt || Date.now()).toISOString().replace(/[:.]/g, '-');
  const restored = [];
  for (const name of Object.keys(FILES)) {
    if (!(name in bundle.data)) continue;
    const target = path.join(DATA_DIR, name);
    try {
      if (fs.existsSync(target)) fs.copyFileSync(target, `${target}.bak-${stamp}`);
    } catch { /* 备份不了也继续,不能因为这个卡住恢复 */ }
    fs.writeFileSync(target, JSON.stringify(bundle.data[name], null, 2));
    restored.push(name);
  }
  return restored;
}

const router = express.Router();

router.get('/export', requireAdmin, (req, res) => {
  const bundle = buildBundle();
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="mcsp-panel-${stamp}.json"`);
  res.send(JSON.stringify(bundle, null, 2));
});

/** 导入前的干跑:只告诉用户"这个包里有什么、会盖掉什么",不动任何文件 */
router.post('/import/preview', requireAdmin, (req, res) => {
  const bundle = req.body && req.body.bundle;
  const err = validateBundle(bundle);
  if (err) return res.status(400).json({ ok: false, error: err });
  const users = bundle.data['users.json'] || [];
  res.json({
    ok: true,
    panelVersion: bundle.panelVersion,
    exportedAt: bundle.exportedAt,
    summary: {
      users: users.length,
      admins: users.filter((u) => u.role === 'admin').length,
      instances: (bundle.data['instances.json'] || []).length,
      tasks: (bundle.data['tasks.json'] || []).length,
      files: Object.keys(bundle.data).filter((f) => f in FILES),
    },
  });
});

router.post('/import', requireAdmin, (req, res) => {
  const bundle = req.body && req.body.bundle;
  const err = validateBundle(bundle);
  if (err) return res.status(400).json({ ok: false, error: err });
  const restored = applyBundle(bundle);
  // 内存里还是旧的用户表和设置,不重启就会出现"文件已经换了、行为还是老的"。
  // 与其做一套热重载(每个模块都得配合),不如老实告诉用户重启面板。
  res.json({
    ok: true, restored,
    note: '配置文件已写入,需要重启面板才会生效。原文件已另存为 .bak-<时间戳>。',
  });
});

module.exports = { router, buildBundle, validateBundle };
