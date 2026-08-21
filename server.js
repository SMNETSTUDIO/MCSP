/**
 * MCSP — MineCraft Server Panel
 *
 * 真实的多实例 Minecraft 服务器管理面板:
 * 实例 = 真实 java 子进程,控制台 = 真实 stdin/stdout,
 * 指标来自 /proc,备份是真实 tar.gz,穿透是真实隧道进程。
 *
 * 代码结构见 src/(分层说明在 ARCHITECTURE.md)。
 */
require('./src/app').start();
