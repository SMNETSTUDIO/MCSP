/**
 * Minecraft RCON 客户端(Valve Source RCON 协议)。
 *
 * 为什么要有它,而不是一直用 stdin:
 *  · stdin 是单向的 —— 敲 `list` 只能等它出现在日志流里再去猜哪一行是回显,
 *    RCON 直接把这条命令的输出返回给你;
 *  · 服务端卡住(比如主线程死锁)时 stdin 管道会跟着堵死,RCON 是独立通道;
 *  · 代理类型(Velocity/Bungee)本来就没有 MC 那套 stdin 命令。
 *
 * 每条命令开一个短连接。对面板这种低频操作,省掉连接保活/重连/并发复用的
 * 一整套状态机比省那点握手开销值得多。
 */
const net = require('net');

const TYPE_AUTH = 3;
const TYPE_EXEC = 2;
const TYPE_RESPONSE = 0;
const CONNECT_TIMEOUT_MS = 5000;
const EXEC_TIMEOUT_MS = 10000;
/* 协议里 length 是 int32,但正常回包不会超过几十 KB;
   设个上限免得对面(或中间人)报一个巨大的长度把内存撑爆 */
const MAX_PACKET = 4 * 1024 * 1024;

function encode(id, type, body) {
  const payload = Buffer.from(body, 'utf8');
  const buf = Buffer.alloc(14 + payload.length);
  buf.writeInt32LE(10 + payload.length, 0);   // 后续长度:id(4) + type(4) + body + 两个 \0
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  payload.copy(buf, 12);
  buf.writeUInt8(0, 12 + payload.length);
  buf.writeUInt8(0, 13 + payload.length);
  return buf;
}

/** 从累积缓冲里切出完整包;不够一个包就返回 null */
function decode(buf) {
  if (buf.length < 4) return null;
  const len = buf.readInt32LE(0);
  if (len < 10 || len > MAX_PACKET) throw new Error(`RCON 包长度异常 (${len})`);
  if (buf.length < 4 + len) return null;
  return {
    id: buf.readInt32LE(4),
    type: buf.readInt32LE(8),
    body: buf.subarray(12, 4 + len - 2).toString('utf8'),
    rest: buf.subarray(4 + len),
  };
}

/**
 * 连上去、认证、执行一条命令、断开。返回命令输出(可能是空串)。
 * 认证失败时服务端回的是 id === -1 —— 这是协议规定的唯一失败信号。
 */
function exec({ host = '127.0.0.1', port, password, command }) {
  return new Promise((resolve, reject) => {
    if (!port) return reject(new Error('未配置 RCON 端口'));
    if (!password) return reject(new Error('未配置 RCON 密码'));

    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let stage = 'auth';
    let out = '';
    let done = false;
    let timer = setTimeout(() => fail(new Error('RCON 连接超时')), CONNECT_TIMEOUT_MS);

    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const fail = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    };

    sock.on('error', (err) => fail(new Error(
      err.code === 'ECONNREFUSED' ? 'RCON 端口拒绝连接(服务端可能没开 enable-rcon,或还没启动完)' : `RCON 连接失败: ${err.message}`,
    )));
    sock.on('close', () => {
      // 命令执行完对面主动断开也算正常结束
      if (stage === 'exec') finish(out);
      else fail(new Error('RCON 连接被对端关闭'));
    });

    sock.on('connect', () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(new Error('RCON 认证超时')), EXEC_TIMEOUT_MS);
      sock.write(encode(1, TYPE_AUTH, password));
    });

    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let pkt;
      try {
        while ((pkt = decode(buf))) {
          buf = pkt.rest;
          if (stage === 'auth') {
            // 有些实现会先回一个空的 RESPONSE_VALUE,忽略它,等 AUTH_RESPONSE
            if (pkt.type === TYPE_RESPONSE) continue;
            if (pkt.id === -1) return fail(new Error('RCON 密码错误'));
            stage = 'exec';
            clearTimeout(timer);
            timer = setTimeout(() => finish(out), EXEC_TIMEOUT_MS);
            sock.write(encode(2, TYPE_EXEC, command));
            continue;
          }
          out += pkt.body;
          // 输出可能分成多个包,再给一小段静默期收尾包
          clearTimeout(timer);
          timer = setTimeout(() => finish(out), 250);
        }
      } catch (err) {
        fail(err);
      }
    });
  });
}

module.exports = { exec };
