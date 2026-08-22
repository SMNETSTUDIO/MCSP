/** 计划任务:持久化存储 + 30 秒粒度调度器 */
const { TASKS_FILE } = require('./config');
const { readJson, writeJson } = require('./utils');
const { instances } = require('./registry');
const { createBackup } = require('./backups');
const bus = require('./bus');

const store = { tasks: readJson(TASKS_FILE, []) };
const saveTasks = () => writeJson(TASKS_FILE, store.tasks);

function taskScheduleText(task) {
  return task.schedule.type === 'interval' ? `每 ${task.schedule.minutes} 分钟` : `每天 ${task.schedule.time}`;
}

const HISTORY_KEEP = 5;

/**
 * 执行一次任务并**如实记录结果**。
 *
 * 原来这里三个毛病:没有 try/catch(抛出去就是个没人接的 rejection);
 * lastRun 在动作之前就写了(所以彻底失败的任务在界面上也显示"刚跑过");
 * 状态不匹配时静默跳过(实例没在跑,重启任务什么也没做,却记成执行成功)。
 * 后两个尤其坑 —— 你以为凌晨自动重启一直在跑,其实它半个月没干过活。
 */
async function runTask(task) {
  const inst = instances.get(task.iid);
  if (!inst) return { ok: false, msg: '实例不存在' };
  const startedAt = Date.now();
  inst.log('INFO', `[MCSP] 计划任务 "${task.name}" 触发 (${taskScheduleText(task)})`);

  let result;
  try {
    result = await performTask(task, inst);
  } catch (err) {
    result = { ok: false, msg: err.message };
  }

  task.lastRun = startedAt;
  task.lastResult = { ...result, at: Date.now(), ms: Date.now() - startedAt };
  task.history = [...(task.history || []), task.lastResult].slice(-HISTORY_KEEP);
  task.failStreak = result.ok ? 0 : (task.failStreak || 0) + 1;
  saveTasks();

  inst.log(result.ok ? 'INFO' : 'WARN',
    `[MCSP] 计划任务 "${task.name}" ${result.ok ? '完成' : '未生效'}: ${result.msg}`
    + (task.failStreak > 1 ? ` (已连续 ${task.failStreak} 次未成功)` : ''));
  bus.broadcast('tasks', { iid: task.iid });
  return task.lastResult;
}

/** 真正干活的部分;"状态不对所以没做"也算一种结果,如实回报而不是假装成功 */
async function performTask(task, inst) {
  switch (task.action) {
    case 'restart':
      if (inst.state !== 'running') return { ok: false, msg: `实例当前是 ${inst.state},未执行重启` };
      return { ok: !!inst.restart().ok, msg: '已发送重启' };
    case 'start':
      if (inst.state !== 'stopped') return { ok: false, msg: `实例当前是 ${inst.state},无需启动` };
      { const r = inst.start(); return { ok: !!r.ok, msg: r.ok ? '已启动' : r.error }; }
    case 'stop':
      if (inst.state !== 'running') return { ok: false, msg: `实例当前是 ${inst.state},无需停止` };
      return { ok: !!inst.stop().ok, msg: '已发送停止' };
    case 'backup': {
      const r = await createBackup(inst, `task-${task.name}`);
      return { ok: !!r.ok, msg: r.ok ? '备份完成' : r.error };
    }
    case 'command': {
      if (!task.payload) return { ok: false, msg: '未配置命令内容' };
      const r = inst.command(task.payload);
      return { ok: !!r.ok, msg: r.ok ? `已执行 ${task.payload}` : r.error };
    }
    default:
      return { ok: false, msg: `未知任务类型 ${task.action}` };
  }
}

function startScheduler() {
  setInterval(() => {
    const now = new Date();
    for (const task of store.tasks) {
      if (!task.enabled) continue;
      if (task.schedule.type === 'interval') {
        const base = task.lastRun || task.createdAt;
        if (Date.now() - base >= task.schedule.minutes * 60000) runTask(task).catch(() => {});
      } else if (task.schedule.type === 'daily') {
        const [h, m] = task.schedule.time.split(':').map(Number);
        if (now.getHours() === h && now.getMinutes() === m && (!task.lastRun || Date.now() - task.lastRun > 90000)) runTask(task).catch(() => {});
      }
    }
  }, 30000);
}

module.exports = { store, saveTasks, taskScheduleText, runTask, startScheduler };
