/**
 * 面板系统设置(data/settings.json):
 *   registrationEnabled — 开放注册:OAuth 未绑定身份能否自动建号(总开关,
 *                         与 OAuth 配置里的 autoCreate 同时为真才放行)
 *   announcement        — 公告:非空时所有用户登录面板后顶部可见
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
  save();
  res.json({ ok: true, settings });
});

module.exports = { get, router };
