/** SSE 事件总线:log / state / metrics / players / instances / tasks / components / java */
/* 载荷是宿主机信息的事件,只发给管理员(与 GET /api/host、/api/java 的口径一致) */
const ADMIN_EVENTS = new Set(['java']);

const bus = {
  subscribers: new Set(),
  // 由 registry 注入:iid -> 允许看到该实例的用户名数组(主人 + 协作者)
  resolveAllowed: null,
  broadcast(event, data) {
    // 实例级事件按可访问集合过滤:普通用户只收到自己(或被分享给自己)实例的流
    let allowed = null;
    if (data && data.iid && this.resolveAllowed) allowed = this.resolveAllowed(data.iid);
    else if (data && data.owner) allowed = [data.owner];
    const adminOnly = ADMIN_EVENTS.has(event);
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.subscribers) {
      const u = res.mcspUser;
      if (adminOnly && (!u || u.role !== 'admin')) continue;
      if (allowed && u && u.role !== 'admin' && !allowed.includes(u.username)) continue;
      try { res.write(payload); } catch { /* 客户端可能已断开 */ }
    }
  },
};

module.exports = bus;
