/**
 * 面板系统设置(data/settings.json):
 *   registrationEnabled — 开放注册:OAuth 未绑定身份能否自动建号(总开关,
 *                         与 OAuth 配置里的 autoCreate 同时为真才放行)
 *   announcement        — 公告:非空时所有用户登录面板后顶部可见
 *   backupKeepCount     — 每个实例最多保留几份备份,0 = 不限
 *   backupKeepDays      — 备份最长保留天数,0 = 不限
 *   notify              — 告警推送目标与事件开关(见 notify.js)
 *   require2FA          — 强制两步验证:没开 TOTP 的账号除了配置 2FA 什么都干不了
 *   thresholds          — 磁盘告警线与崩溃重启策略(原先是源码里的常量)
 */
const path = require('path');
const express = require('express');
const { DATA_DIR } = require('./config');
const { readJson, writeJson } = require('./utils');
const { requireAdmin, users } = require('./auth');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const settings = {
  registrationEnabled: true,
  announcement: '',
  announcementAt: 0,
  // 备份保留:默认留 10 份 / 30 天。老面板升上来也会拿到这个默认值 ——
  // 无限增长是个沉默的故障(磁盘满了才发现),给个保守默认比不管强
  backupKeepCount: 10,
  backupKeepDays: 30,
  // 强制两步验证。默认关 —— 打开会立刻把所有没配 TOTP 的人挡在门外,
  // 这种影响面的开关不该由升级悄悄替用户做决定
  require2FA: false,
  /* 阈值。这几个原来是 disk.js / instance.js 里的常量,想调就得改源码重启面板。
     模组服天生崩得勤、小硬盘要早点告警 —— 这些本来就该是每个部署自己的事。
     读取一律在用的时候现读(不缓存到模块变量),存完下一次判断就生效。 */
  thresholds: {
    diskWarnPct: 90,        // 宿主机磁盘用量超过这个百分比告警
    crashWindowMin: 10,     // 崩溃计数窗口(分钟)
    crashMaxRestarts: 3,    // 窗口内最多自动拉起几次,0 = 关闭崩溃自动重启
    crashRestartDelaySec: 5, // 崩溃后隔多久再拉
  },
  notify: {
    enabled: false,
    webhookUrl: '',
    discordUrl: '',
    telegramToken: '',
    telegramChatId: '',
    // 默认全开;真正的总开关是 enabled,没配目标也不会发
    events: { crash: true, restartBlocked: true, backupFailed: true, taskFailed: true, diskLow: true },
  },
  ...readJson(SETTINGS_FILE, {}),
};

// 老配置文件里没有 thresholds / notify 或缺字段时补齐,免得各处到处判空
settings.thresholds = {
  diskWarnPct: 90, crashWindowMin: 10, crashMaxRestarts: 3, crashRestartDelaySec: 5,
  ...(settings.thresholds || {}),
};

settings.notify = {
  enabled: false, webhookUrl: '', discordUrl: '', telegramToken: '', telegramChatId: '',
  ...(settings.notify || {}),
  events: { crash: true, restartBlocked: true, backupFailed: true, taskFailed: true, diskLow: true,
            ...((settings.notify || {}).events || {}) },
};

const save = () => writeJson(SETTINGS_FILE, settings);
const get = () => settings;

const router = express.Router();

/* 普通用户只该看到影响自己的那几项。notify 里存着 webhook 地址和 Telegram
   Bot Token —— 之前这个接口对任何登录用户都全量返回,等于把推送凭据发给租户。 */
function publicView(s) {
  return {
    announcement: s.announcement,
    announcementAt: s.announcementAt,
    backupKeepCount: s.backupKeepCount,
    backupKeepDays: s.backupKeepDays,
    require2FA: s.require2FA,
  };
}

router.get('/', (req, res) => res.json(req.user.role === 'admin' ? settings : publicView(settings)));

router.put('/', requireAdmin, (req, res) => {
  const b = req.body || {};
  if ('registrationEnabled' in b) settings.registrationEnabled = !!b.registrationEnabled;
  /* 强制两步验证:自己没配 TOTP 就不许打开。
     开关一旦打开,连管理员自己都会被 requireTwoFactor 挡在门外,而系统设置页
     本身也在拦截范围内 —— 也就是说没配 2FA 的人打开它,等于把自己锁死,
     只能去改磁盘上的 JSON 再重启。原来这里只有前端一个 confirm 弹窗,
     点「确定」就能把自己锁出去,API 直连更是毫无阻拦。改成后端硬拦。
     关闭不设限制:那是逃生方向,永远该放行。 */
  if ('require2FA' in b) {
    const want = !!b.require2FA;
    if (want && !settings.require2FA) {
      const me = users.find((u) => u.username === req.user.username);
      if (!(me && me.totp && me.totp.enabled)) {
        return res.status(400).json({
          ok: false, code: 'self_2fa_required',
          error: '你自己还没有启用两步验证。请先在「账号安全」中配置 TOTP,否则开启后你会被锁在面板外。',
        });
      }
    }
    settings.require2FA = want;
  }
  if (b.thresholds && typeof b.thresholds === 'object') {
    // 每项都有下限:磁盘告警线设成 5% 会天天响,窗口设成 0 分钟等于永不计数
    const lim = {
      diskWarnPct: [50, 99], crashWindowMin: [1, 1440],
      crashMaxRestarts: [0, 100], crashRestartDelaySec: [1, 3600],
    };
    for (const [k, [lo, hi]] of Object.entries(lim)) {
      if (!(k in b.thresholds)) continue;
      const n = parseInt(b.thresholds[k], 10);
      if (Number.isFinite(n) && n >= lo && n <= hi) settings.thresholds[k] = n;
    }
  }
  if ('announcement' in b) {
    const text = String(b.announcement || '').slice(0, 500).trim();
    if (text !== settings.announcement) settings.announcementAt = Date.now();
    settings.announcement = text;
  }
  for (const k of ['backupKeepCount', 'backupKeepDays']) {
    if (!(k in b)) continue;
    const n = parseInt(b[k], 10);
    if (Number.isFinite(n) && n >= 0 && n <= 3650) settings[k] = n;
  }
  if (b.notify && typeof b.notify === 'object') {
    const n = b.notify;
    const str = (v, max) => String(v || '').trim().slice(0, max);
    settings.notify = {
      enabled: !!n.enabled,
      webhookUrl: str(n.webhookUrl, 500),
      discordUrl: str(n.discordUrl, 500),
      telegramToken: str(n.telegramToken, 200),
      telegramChatId: str(n.telegramChatId, 64),
      events: { ...settings.notify.events, ...(n.events || {}) },
    };
  }
  save();
  res.json({ ok: true, settings });
});

/* 测试推送:同步等结果,逐条回显哪个通道通了 */
router.post('/notify/test', requireAdmin, async (req, res) => {
  const notify = require('./notify');
  // 用请求体里的配置试,这样用户不用先保存再测
  const cfg = (req.body && req.body.notify) || settings.notify;
  res.json({ ok: true, results: await notify.test(cfg) });
});

module.exports = { get, router };
