/** SSE 事件总线:log / state / metrics / players / instances / tasks / components / java */
const bus = {
  subscribers: new Set(),
  resolveOwner: null,   // 由 registry 注入:iid -> owner,避免循环依赖
  broadcast(event, data) {
    // 实例级事件按归属过滤:普通用户只收到自己实例的日志/指标/状态
    const owner = data && (data.owner ||
      (data.iid && this.resolveOwner ? this.resolveOwner(data.iid) : null));
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.subscribers) {
      const u = res.mcspUser;
      if (owner && u && u.role !== 'admin' && u.username !== owner) continue;
      try { res.write(payload); } catch { /* 客户端可能已断开 */ }
    }
  },
};

module.exports = bus;
