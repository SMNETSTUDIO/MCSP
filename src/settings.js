/**
 * 面板系统设置(data/settings.json):
 *   registrationEnabled — 开放注册:OAuth 未绑定身份能否自动建号(总开关,
 *                         与 OAuth 配置里的 autoCreate 同时为真才放行)
 *   announcement        — 公告:非空时所有用户登录面板后顶部可见
 *   backupKeepCount     — 每个实例最多保留几份备份,0 = 不限
 *   backupKeepDays      — 备份最长保留天数,0 = 不限
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
  ...readJson(SETTINGS_FILE, {}),
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
  save();
  res.json({ ok: true, settings });
});

module.exports = { get, router };
