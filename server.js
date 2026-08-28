/**
 * MCSP — MineCraft Server Panel
 *
 * 真实的多实例 Minecraft 服务器管理面板:
 * 实例 = 真实 java 子进程,控制台 = 真实 stdin/stdout,
 * 指标来自 /proc,备份是真实 tar.gz,穿透是真实隧道进程。
 *
 * 代码结构见 src/(分层说明在 ARCHITECTURE.md)。
 */
/* 最后一道兜底。面板里跑着别人的 Minecraft 服务器 —— 一个后台定时器里的
   意外异常不该让所有服务端跟着进程一起消失。记下来继续跑,比静默退出、
   再由 PM2 拉起、再 resumeInstances 把服务端重启一遍要好得多。
   注意这不是"忽略错误":该修的照修,这里只是不让它变成全员停服。 */
process.on('uncaughtException', (err) => {
  console.error('[MCSP] 未捕获异常(进程继续运行,请上报此堆栈):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[MCSP] 未处理的 Promise rejection:', reason);
});

require('./src/app').start();
