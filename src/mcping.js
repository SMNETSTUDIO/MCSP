/** 真实连通性检测:向目标地址发起 Minecraft status ping */
const net = require('net');

function mcPing(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (settled) return; settled = true; try { sock.destroy(); } catch {} resolve(r); };
    const varint = (n) => { const b = []; while (true) { if ((n & ~0x7f) === 0) { b.push(n); break; } b.push((n & 0x7f) | 0x80); n >>>= 7; } return Buffer.from(b); };
    const hostBuf = Buffer.from(host);
    const hs = Buffer.concat([
      Buffer.from([0x00]), varint(770), varint(hostBuf.length), hostBuf,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]), Buffer.from([0x01]),
    ]);
    const sock = net.connect({ host, port, timeout: timeoutMs });
    let acc = Buffer.alloc(0);
    sock.on('connect', () => sock.write(Buffer.concat([varint(hs.length), hs, Buffer.from([0x01, 0x00])])));
    sock.on('data', (d) => {
      acc = Buffer.concat([acc, d]);
      const t = acc.toString('utf8');
      const i = t.indexOf('{');
      if (i >= 0) {
        try {
          const j = JSON.parse(t.slice(i, t.lastIndexOf('}') + 1));
          return done({ ok: true, version: (j.version && j.version.name) || null });
        } catch { /* JSON 还没收完整,继续等 */ }
      }
    });
    sock.on('timeout', () => done({ ok: false, error: '连接超时' }));
    sock.on('error', (e) => done({ ok: false, error: e.code === 'ECONNRESET' ? '连接被远端重置(服务商未真正转发数据)' : e.message }));
    sock.on('close', () => done({ ok: false, error: acc.length ? 'MC 响应不完整' : '连接被远端关闭,未收到任何数据' }));
    setTimeout(() => done({ ok: false, error: '超时未收到 MC 响应' }), timeoutMs + 500);
  });
}

module.exports = { mcPing };
