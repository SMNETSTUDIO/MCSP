/**
 * 告警推送:通用 Webhook / Telegram / Discord。
 *
 * 面板此前出了事一声不吭 —— 服崩了、备份失败了、磁盘快满了,都得你自己去翻界面。
 * 这里只做"把事说出去",判断什么算事件由各调用点负责。
 *
 * 三条设计约束:
 *  · 推送失败绝不能影响主流程(备份失败已经够糟了,不该再因为 webhook 超时炸一次);
 *  · 同一件事短时间内只说一次,否则崩溃重启循环会把群刷爆;
 *  · 目标地址由管理员配置,发送前校验协议,避免被当成内网探测器。
 */
const settings = require('./settings');

const TIMEOUT_MS = 8000;
const DEDUPE_MS = 5 * 60_000;

/** 可推送的事件类型 —— 键要和系统设置里的开关一一对应 */
const EVENTS = {
  crash: '实例异常退出',
  restartBlocked: '重启风暴保护触发(已放弃自动重启)',
  backupFailed: '备份失败',
  taskFailed: '计划任务连续失败',
  diskLow: '磁盘空间不足',
};

/** event+key → 上次发送时间,用于去重 */
const lastSent = new Map();

function shouldSend(event, key) {
  const now = Date.now();
  const id = `${event}:${key}`;
  const prev = lastSent.get(id);
  if (prev && now - prev < DEDUPE_MS) return false;
  lastSent.set(id, now);
  // 顺手清理过期项,免得长期运行后这个 Map 只增不减
  if (lastSent.size > 500) {
    for (const [k, t] of lastSent) if (now - t > DEDUPE_MS) lastSent.delete(k);
  }
  return true;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** 各通道的发送实现;返回 {name, ok, error} 便于「测试推送」逐条回显 */
async function deliver(cfg, { event, title, text }) {
  const out = [];
  const label = EVENTS[event] || event;
  const plain = `【MCSP】${title}\n${text}`;

  if (cfg.webhookUrl) {
    out.push(await attempt('Webhook', () => postJson(cfg.webhookUrl, {
      source: 'mcsp', event, label, title, text, at: new Date().toISOString(),
    })));
  }
  if (cfg.discordUrl) {
    // Discord webhook 认 content 字段
    out.push(await attempt('Discord', () => postJson(cfg.discordUrl, { content: plain.slice(0, 1900) })));
  }
  if (cfg.telegramToken && cfg.telegramChatId) {
    out.push(await attempt('Telegram', () => postJson(
      `https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`,
      { chat_id: cfg.telegramChatId, text: plain.slice(0, 4000), disable_web_page_preview: true },
    )));
  }
  return out;
}

async function attempt(name, fn) {
  try { await fn(); return { name, ok: true }; }
  catch (err) { return { name, ok: false, error: err.message }; }
}

/** 配置合法性:只放行 http(s),挡掉 file:// 之类 */
function usableTargets(cfg) {
  const ok = (u) => typeof u === 'string' && /^https?:\/\/\S+$/.test(u);
  return {
    webhookUrl: ok(cfg.webhookUrl) ? cfg.webhookUrl : '',
    discordUrl: ok(cfg.discordUrl) ? cfg.discordUrl : '',
    telegramToken: cfg.telegramToken || '',
    telegramChatId: cfg.telegramChatId || '',
  };
}

/**
 * 发一条告警。永不抛错、永不阻塞调用方 —— 调用点用不着 await,
 * 也用不着 try/catch。dedupeKey 相同的事件 5 分钟内只发一次。
 */
function emit(event, { title, text, dedupeKey = '' }) {
  const cfg = (settings.get().notify) || {};
  if (!cfg.enabled) return;
  if (cfg.events && cfg.events[event] === false) return;
  const targets = usableTargets(cfg);
  if (!targets.webhookUrl && !targets.discordUrl && !(targets.telegramToken && targets.telegramChatId)) return;
  if (!shouldSend(event, dedupeKey)) return;

  deliver(targets, { event, title, text }).then((results) => {
    const bad = results.filter((r) => !r.ok);
    if (bad.length) console.error('[MCSP] 告警推送失败:', bad.map((b) => `${b.name}: ${b.error}`).join('; '));
  }).catch((err) => console.error('[MCSP] 告警推送异常:', err.message));
}

/** 「测试推送」用:同步等结果并逐条回显,不走去重 */
async function test(cfg) {
  const targets = usableTargets(cfg);
  if (!targets.webhookUrl && !targets.discordUrl && !(targets.telegramToken && targets.telegramChatId)) {
    return [{ name: '(无)', ok: false, error: '还没有配置任何推送目标' }];
  }
  return deliver(targets, {
    event: 'test',
    title: '测试推送',
    text: `这是一条来自 MCSP 的测试消息,时间 ${new Date().toLocaleString('zh-CN')}。收到即说明配置可用。`,
  });
}

module.exports = { emit, test, EVENTS };
