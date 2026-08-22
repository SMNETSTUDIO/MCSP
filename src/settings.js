/**
 * 面板系统设置(data/settings.json):
 *   registrationEnabled — 开放注册:OAuth 未绑定身份能否自动建号(总开关,
 *                         与 OAuth 配置里的 autoCreate 同时为真才放行)
 *   announcement        — 公告:非空时所有用户登录面板后顶部可见
 *   backupKeepCount     — 每个实例最多保留几份备份,0 = 不限
 *   backupKeepDays      — 备份最长保留天数,0 = 不限
 *   notify              — 告警推送目标与事件开关(见 notify.js)
 */
const path = require('path');
const express = require('express');
const { DATA_DIR } = require('./config');
const { readJson, writeJson } = require('./utils');
const { requireAdmin } = require('./auth');

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

const settings = {
  registrationEnabled: true,
  announcement: '',
  announcementAt: 0,
  // 备份保留:默认留 10 份 / 30 天。老面板升上来也会拿到这个默认值 ——
  // 无限增长是个沉默的故障(磁盘满了才发现),给个保守默认比不管强
  backupKeepCount: 10,
  backupKeepDays: 30,
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

// 老配置文件里没有 notify 或缺字段时补齐,免得各处到处判空
settings.notify = {
  enabled: false, webhookUrl: '', discordUrl: '', telegramToken: '', telegramChatId: '',
  ...(settings.notify || {}),
  events: { crash: true, restartBlocked: true, backupFailed: true, taskFailed: true, diskLow: true,
            ...((settings.notify || {}).events || {}) },
};

const save = () => writeJson(SETTINGS_FILE, settings);
const get = () => settings;

const router = express.Router();

router.get('/', (req, res) => res.json(settings));

router.put('/', requireAdmin, (req, res) => {
  const b = req.body || {};
  if ('registrationEnabled' in b) settings.registrationEnabled = !!b.registrationEnabled;
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
