/**
 * 压缩包:zip 用 zlib 自己读写(不引依赖),tar 家族交给系统 tar。
 *
 * 安全前提 —— 解压的输入是用户上传的整合包/世界包,必须当成不可信数据:
 *   · 条目名里的 `..` / 绝对路径会被拒绝,落地路径再校验一次是否还在 dest 内;
 *   · 符号链接条目一律拒绝 —— GNU tar 会挡住 `..`,但挡不住
 *     "解压出一个 esc -> / 的软链,下次再往 esc/ 里写" 这种两步逃逸;
 *   · 解压后总体积有上限,防 zip bomb 把磁盘塞满。
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const events = require('events');
const { spawn } = require('child_process');
const { Transform, Writable } = require('stream');
const { pipeline } = require('stream/promises');

// .jar 也是 zip,但插件/模组列表里每行都挂个「解压」既碍眼又容易误点,
// 真想拆开的把它改名成 .zip 即可
const ZIP_EXT = ['.zip', '.mrpack'];
const TAR_EXT = ['.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tbz2', '.tbz', '.tar.xz', '.txz'];

/** 压缩包类型;不是压缩包返回 null(按后缀判断,双段后缀优先) */
function archiveKind(name) {
  const lower = String(name).toLowerCase();
  if (TAR_EXT.some((e) => lower.endsWith(e))) return 'tar';
  if (ZIP_EXT.some((e) => lower.endsWith(e))) return 'zip';
  return null;
}

/* ── crc32(zip 用的 IEEE 多项式,可续算)── */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** crc32(b1b2) === crc32(b2, crc32(b1)),所以能一块一块喂 */
function crc32(buf, prev = 0) {
  let c = ~prev >>> 0;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return ~c >>> 0;
}

/* ── 路径 ── */

/**
 * 把压缩包里的条目名拼到 dest 下,越界返回 null。
 * 反斜杠按分隔符处理:Windows 上打的包偶尔会写成 `mods\foo.jar`。
 * 名字只剩空(`./`,`tar cf x .` 的产物)时就是 dest 自己。
 */
function safeJoin(dest, entryName) {
  const parts = String(entryName).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) return null;
  if (!parts.length) return dest;
  const p = path.join(dest, ...parts);
  return p.startsWith(dest + path.sep) ? p : null;
}

/* ── zip 文件名解码 ── */

const utf8Strict = new TextDecoder('utf-8', { fatal: true });
// 中文用户手上的老 zip 多半是 GBK 名;Node 自带 full-icu 才有这个解码器
let gbkDecoder = null;
try { gbkDecoder = new TextDecoder('gbk', { fatal: true }); } catch {}

function decodeEntryName(buf, utf8Flag) {
  if (utf8Flag) return buf.toString('utf8');
  try { return utf8Strict.decode(buf); } catch {}
  if (gbkDecoder) { try { return gbkDecoder.decode(buf); } catch {} }
  return buf.toString('latin1');
}

/* ── zip:读中央目录 ── */

/** 读完整的中央目录条目表(含 zip64 补齐) */
async function readZipEntries(fh, size) {
  // EOCD 固定 22 字节 + 最多 64 KB 注释,从尾巴往前找签名
  const tailLen = Math.min(size, 22 + 65535 + 20);
  const tail = Buffer.alloc(tailLen);
  await fh.read(tail, 0, tailLen, size - tailLen);

  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 zip(找不到中央目录)');

  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);

  // 字段被填成全 F 说明真实值放在 zip64 记录里
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('zip64 定位记录缺失,压缩包可能已损坏');
    const z64 = Buffer.alloc(56);
    await fh.read(z64, 0, 56, Number(tail.readBigUInt64LE(loc + 8)));
    if (z64.readUInt32LE(0) !== 0x06064b50) throw new Error('zip64 中央目录记录无效');
    count = Number(z64.readBigUInt64LE(32));
    cdSize = Number(z64.readBigUInt64LE(40));
    cdOffset = Number(z64.readBigUInt64LE(48));
  }
  if (cdOffset + cdSize > size) throw new Error('中央目录越界,压缩包可能已损坏');

  const cd = Buffer.alloc(cdSize);
  await fh.read(cd, 0, cdSize, cdOffset);

  const entries = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const madeBy = cd.readUInt16LE(p + 4);
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const crc = cd.readUInt32LE(p + 16);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const attrs = cd.readUInt32LE(p + 38);
    let comp = cd.readUInt32LE(p + 20);
    let uncomp = cd.readUInt32LE(p + 24);
    let local = cd.readUInt32LE(p + 42);
    const rawName = cd.subarray(p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    p += 46 + nameLen + extraLen + commentLen;

    // zip64 扩展字段:只有被填成 0xFFFFFFFF 的字段才出现,顺序固定
    for (let e = 0; e + 4 <= extra.length; e += 4 + extra.readUInt16LE(e + 2)) {
      if (extra.readUInt16LE(e) !== 0x0001) continue;
      let q = e + 4;
      const take = () => { const v = Number(extra.readBigUInt64LE(q)); q += 8; return v; };
      if (uncomp === 0xffffffff && q + 8 <= extra.length) uncomp = take();
      if (comp === 0xffffffff && q + 8 <= extra.length) comp = take();
      if (local === 0xffffffff && q + 8 <= extra.length) local = take();
      break;
    }

    const name = decodeEntryName(rawName, !!(flags & 0x800));
    // 高 16 位是 unix mode,但只有 "made by UNIX" 的包才填
    const mode = madeBy >> 8 === 3 ? (attrs >>> 16) & 0xffff : 0;
    entries.push({
      name, method, crc, comp, uncomp, local,
      isDir: name.endsWith('/') || !!(attrs & 0x10),
      isSymlink: (mode & 0xf000) === 0xa000,
      encrypted: !!(flags & 0x01),
    });
  }
  return entries;
}

/** 把单个条目流式解到 target(边解边算 crc,不整块进内存) */
async function extractZipEntry(file, fh, e, target) {
  if (e.comp === 0) {
    // 存储方式的空文件:没有数据区,createReadStream 的 end < start 会直接报错
    if (e.uncomp !== 0) throw new Error(`条目数据缺失: ${e.name}`);
    return fsp.writeFile(target, '');
  }
  const head = Buffer.alloc(30);
  await fh.read(head, 0, 30, e.local);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new Error(`局部文件头损坏: ${e.name}`);
  // 局部头的名字/扩展长度可能和中央目录不一致,数据起点必须按局部头算
  const start = e.local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);

  let crc = 0;
  let written = 0;
  const tally = new Transform({
    transform(chunk, _enc, cb) { crc = crc32(chunk, crc); written += chunk.length; cb(null, chunk); },
  });
  const src = fs.createReadStream(file, { start, end: start + e.comp - 1 });
  const stages = e.method === 8 ? [src, zlib.createInflateRaw(), tally] : [src, tally];
  await pipeline(...stages, fs.createWriteStream(target));

  if (written !== e.uncomp || crc !== e.crc) throw new Error(`解压校验失败(内容与校验和不符): ${e.name}`);
}

async function extractZip(file, dest, maxBytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const entries = await readZipEntries(fh, size);

    // 先整包体检再动手,免得解到一半留一地半成品
    if (entries.some((e) => e.encrypted)) throw new Error('压缩包已加密,面板不支持带密码的 zip');
    if (entries.some((e) => e.isSymlink)) throw new Error('压缩包内含符号链接,已拒绝解压');
    const bad = entries.find((e) => e.method !== 0 && e.method !== 8);
    if (bad) throw new Error(`不支持的压缩算法 (method ${bad.method}): ${bad.name}`);
    const total = entries.reduce((s, e) => s + (e.isDir ? 0 : e.uncomp), 0);
    if (total > maxBytes) {
      throw new Error(`解压后约 ${(total / 1073741824).toFixed(2)} GB,超过上限 ${(maxBytes / 1073741824).toFixed(2)} GB`);
    }
    const targets = entries.map((e) => {
      const t = safeJoin(dest, e.name);
      if (!t || (t === dest && !e.isDir)) throw new Error(`压缩包内含非法路径: ${e.name}`);
      return t;
    });

    let files = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.isDir) { await fsp.mkdir(targets[i], { recursive: true }); continue; }
      await fsp.mkdir(path.dirname(targets[i]), { recursive: true });
      await extractZipEntry(file, fh, e, targets[i]);
      files++;
    }
    return { files, bytes: total };
  } finally {
    await fh.close();
  }
}

/* ── tar:交给系统 tar,但先列一遍清单做安全校验 ── */

function runTar(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('tar', args);
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { if (err.length < 2000) err += d; });
    p.on('error', (e) => reject(new Error(e.code === 'ENOENT' ? '系统未安装 tar' : e.message)));
    p.on('exit', (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n')[0] || `tar 退出码 ${code}`))));
  });
}

async function extractTar(file, dest, maxBytes) {
  // -tv 的第一列是类型字符;这一趟会把包整个解压一遍只为看清单,
  // 但换来的是"能确认里面没有软链再落盘",值。
  const listing = (await runTar(['-tvf', file])).split('\n').filter(Boolean);
  let total = 0;
  let files = 0;
  for (const line of listing) {
    const type = line[0];
    if (type !== '-' && type !== 'd') {
      throw new Error(`压缩包内含非普通文件条目(${type}),已拒绝解压 —— 符号链接可能指向实例目录之外`);
    }
    const m = /^\S+\s+\S+\s+(\d+)\s+\d[\d-]*\s+[\d:]+\s+(.+)$/.exec(line);
    if (m) {
      total += parseInt(m[1], 10);
      if (!safeJoin(dest, m[2])) throw new Error(`压缩包内含非法路径: ${m[2]}`);
    }
    if (type === '-') files++;
  }
  if (total > maxBytes) {
    throw new Error(`解压后约 ${(total / 1073741824).toFixed(2)} GB,超过上限 ${(maxBytes / 1073741824).toFixed(2)} GB`);
  }

  await fsp.mkdir(dest, { recursive: true });
  await runTar(['-xf', file, '-C', dest, '--no-same-owner', '--no-same-permissions']);
  return { files, bytes: total };
}

/** 解压到 dest(自动建目录);返回 { files, bytes } */
function extractArchive(file, dest, maxBytes) {
  const kind = archiveKind(file);
  if (kind === 'zip') return extractZip(file, dest, maxBytes);
  if (kind === 'tar') return extractTar(file, dest, maxBytes);
  return Promise.reject(new Error('不支持的压缩包格式'));
}

/* ── 打包 ── */

/** 递归收集要打包的条目;软链跳过(打进去只会给解压方添麻烦) */
async function collect(baseDir, rel, acc) {
  const abs = path.join(baseDir, rel);
  const st = await fsp.lstat(abs);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    const children = await fsp.readdir(abs);
    acc.push({ rel, abs, isDir: true, size: 0, mtime: st.mtime });
    for (const c of children.sort()) await collect(baseDir, path.posix.join(rel, c), acc);
  } else if (st.isFile()) {
    acc.push({ rel, abs, isDir: false, size: st.size, mtime: st.mtime });
  }
}

/** JS Date → DOS 时间/日期对(zip 的时间戳格式,1980 年起步) */
function dosStamp(d) {
  const y = Math.max(1980, d.getFullYear());
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff,
    date: (((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff,
  };
}

// zip32 的偏移量字段是 32 位;超过就得上 zip64,那不如让用户选 tar.gz
const ZIP32_LIMIT = 4 * 1073741824 - 1048576;

async function createZip(out, baseDir, names) {
  const items = [];
  for (const n of names) await collect(baseDir, n, items);
  if (!items.length) throw new Error('没有可打包的内容');
  if (items.length > 65535) throw new Error(`条目数 ${items.length} 超过 zip 上限(65535),请改用 tar.gz`);
  const raw = items.reduce((s, i) => s + i.size, 0);
  if (raw > ZIP32_LIMIT) throw new Error(`内容共 ${(raw / 1073741824).toFixed(2)} GB,超过 zip 的 4 GB 上限,请改用 tar.gz`);

  const ws = fs.createWriteStream(out);
  try {
    return await writeZip(ws, out, items, raw);
  } catch (err) {
    ws.destroy();                              // 半路失败也别把 fd 挂在那儿
    throw err;
  }
}

/** 顺序写出 local header + 数据 + 中央目录 + EOCD,最后回填局部头 */
async function writeZip(ws, out, items, raw) {
  let streamErr = null;
  ws.on('error', (e) => { streamErr = e; });
  let offset = 0;
  const put = async (buf) => {
    if (streamErr) throw streamErr;
    if (!ws.write(buf)) await events.once(ws, 'drain');
    offset += buf.length;
  };

  const recs = [];
  for (const it of items) {
    const nameBuf = Buffer.from(it.rel + (it.isDir ? '/' : ''), 'utf8');
    const { time, date } = dosStamp(it.mtime);
    const rec = { nameBuf, time, date, isDir: it.isDir, header: offset, crc: 0, comp: 0, raw: 0 };

    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);                     // 需要 2.0 才能解(deflate)
    h.writeUInt16LE(0x0800, 6);                 // 文件名是 UTF-8
    h.writeUInt16LE(it.isDir ? 0 : 8, 8);       // 目录用存储,文件用 deflate
    h.writeUInt16LE(time, 10);
    h.writeUInt16LE(date, 12);
    h.writeUInt16LE(nameBuf.length, 26);
    // crc / 压缩前后大小要等数据流完才知道,先留零,最后回填局部头
    await put(h);
    await put(nameBuf);

    if (!it.isDir) {
      await pipeline(
        fs.createReadStream(it.abs),
        new Transform({
          transform(c, _e, cb) { rec.crc = crc32(c, rec.crc); rec.raw += c.length; cb(null, c); },
        }),
        zlib.createDeflateRaw(),
        // 不用 ws 本身收尾:pipeline 结束会把它 end 掉,后面还要写中央目录
        new Writable({
          write(c, _e, cb) { rec.comp += c.length; put(c).then(() => cb(), cb); },
        }),
      );
    }
    recs.push(rec);
  }

  const cdStart = offset;
  for (const r of recs) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(0x031e, 4);                 // made by: UNIX(3) + 规范 3.0
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(r.isDir ? 0 : 8, 10);
    c.writeUInt16LE(r.time, 12);
    c.writeUInt16LE(r.date, 14);
    c.writeUInt32LE(r.crc, 16);
    c.writeUInt32LE(r.comp, 20);
    c.writeUInt32LE(r.raw, 24);
    c.writeUInt16LE(r.nameBuf.length, 28);
    // 外部属性:高 16 位 unix mode(目录 0755 / 文件 0644),低位是 DOS 目录标志
    c.writeUInt32LE(r.isDir ? 0x41ed0010 : 0x81a40000, 38);
    c.writeUInt32LE(r.header, 42);
    await put(c);
    await put(r.nameBuf);
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(recs.length, 8);
  eocd.writeUInt16LE(recs.length, 10);
  eocd.writeUInt32LE(offset - cdStart, 12);
  eocd.writeUInt32LE(cdStart, 16);
  await put(eocd);
  await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
  if (streamErr) throw streamErr;

  // 回填局部头里预留的 crc32 / 压缩后大小 / 原始大小(局部头 +14 起的 12 字节)
  const fh = await fsp.open(out, 'r+');
  try {
    for (const r of recs) {
      const b = Buffer.alloc(12);
      b.writeUInt32LE(r.crc, 0);
      b.writeUInt32LE(r.comp, 4);
      b.writeUInt32LE(r.raw, 8);
      await fh.write(b, 0, 12, r.header + 14);
    }
  } finally {
    await fh.close();
  }
  return { files: recs.filter((r) => !r.isDir).length, bytes: raw };
}

async function createTarGz(out, baseDir, names) {
  const items = [];
  for (const n of names) await collect(baseDir, n, items);
  if (!items.length) throw new Error('没有可打包的内容');
  await runTar(['czf', out, '-C', baseDir, ...names]);
  return { files: items.filter((i) => !i.isDir).length, bytes: items.reduce((s, i) => s + i.size, 0) };
}

/** 把 baseDir 下的 names(单段名)打包到 out;format 为 'zip' 或 'tar.gz' */
function createArchive(out, baseDir, names, format) {
  return format === 'tar.gz' ? createTarGz(out, baseDir, names) : createZip(out, baseDir, names);
}

module.exports = { archiveKind, extractArchive, createArchive, ZIP_EXT, TAR_EXT };
