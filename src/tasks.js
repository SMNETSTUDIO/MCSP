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

async function runTask(task) {
  const inst = instances.get(task.iid);
  if (!inst) return;
  task.lastRun = Date.now();
  saveTasks();
  inst.log('INFO', `[MCSP] 计划任务 "${task.name}" 触发 (${taskScheduleText(task)})`);
  if (task.action === 'restart' && inst.state === 'running') inst.restart();
  else if (task.action === 'backup') await createBackup(inst, `task-${task.name}`);
  else if (task.action === 'command' && task.payload) inst.command(task.payload);
  else if (task.action === 'start' && inst.state === 'stopped') inst.start();
  else if (task.action === 'stop' && inst.state === 'running') inst.stop();
  bus.broadcast('tasks', { iid: task.iid });
}

function startScheduler() {
  setInterval(() => {
    const now = new Date();
    for (const task of store.tasks) {
      if (!task.enabled) continue;
      if (task.schedule.type === 'interval') {
        const base = task.lastRun || task.createdAt;
        if (Date.now() - base >= task.schedule.minutes * 60000) runTask(task);
      } else if (task.schedule.type === 'daily') {
        const [h, m] = task.schedule.time.split(':').map(Number);
        if (now.getHours() === h && now.getMinutes() === m && (!task.lastRun || Date.now() - task.lastRun > 90000)) runTask(task);
      }
    }
  }, 30000);
}

module.exports = { store, saveTasks, taskScheduleText, runTask, startScheduler };
