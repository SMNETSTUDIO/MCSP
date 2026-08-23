/**
 * 备份:tar.gz 全量归档 + GNU tar 增量链,备份前自动 save-all。
 *
 * 增量(功能 5)靠 GNU tar 的 --listed-incremental:一个快照文件(.snar)记着
 * 上次备份时每个文件的 mtime/inode,下次只打包变过的部分。世界动辄几十 GB
 * 而每天真正变的可能只有几百 MB,全量存七天等于把同一份世界抄七遍。
 *
 * 一条"链" = 1 个全量 + 若干增量,共用一个 .snar。恢复第 N 个增量必须
 * 按顺序应用 全量 → inc1 → … → incN,少一环就不完整 —— 所以链的元数据
 * (谁是谁的 base、第几个)必须落盘,不能靠文件名猜。
 *
 * busybox 的 tar 没有 --listed-incremental,检测不到就只给全量,
 * 并如实告诉用户为什么(而不是悄悄退化成全量让人以为省了空间)。
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { BACKUPS_DIR } = require('./config');
const settings = require('./settings');
const notify = require('./notify');

/* GNU tar 才有 --listed-incremental;busybox/bsdtar 都没有 */
const INCREMENTAL_OK = (() => {
  try {
    const r = spawnSync('tar', ['--usage'], { encoding: 'utf8' });
    return /listed-incremental/.test((r.stdout || '') + (r.stderr || ''));
  } catch { return false; }
})();

function backupDir(inst) {
  const d = path.join(BACKUPS_DIR, inst.id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/* 链元数据:{ [backupId]: { type:'full'|'inc', base:<fullId>, seq:N } }。
   放在备份目录里的隐藏文件,跟着备份一起走;listBackups 过滤 .tar.gz,
   所以它不会被当成一份备份显示出来。 */
function chainFile(inst) { return path.join(backupDir(inst), '.mcsp-chains.json'); }

function readChains(inst) {
  try { return JSON.parse(fs.readFileSync(chainFile(inst), 'utf8')); } catch { return {}; }
}

function writeChains(inst, c) {
  try { fs.writeFileSync(chainFile(inst), JSON.stringify(c, null, 2)); } catch { /* 元数据写不动时下面会退化成全量,不致命 */ }
}

function snarPath(inst, fullId) {
  const d = path.join(backupDir(inst), '.snar');
  fs.mkdirSync(d, { recursive: true });
  return path.join(d, `${fullId}.snar`);
}

function listBackups(inst) {
  const chains = readChains(inst);
  return fs.readdirSync(backupDir(inst))
    .filter((f) => f.endsWith('.tar.gz'))
    .map((f) => {
      const st = fs.statSync(path.join(backupDir(inst), f));
      const meta = chains[f] || null;
      return {
        id: f,
        name: f.replace(/\.tar\.gz$/, ''),
        size: st.size,
        sizeMB: +(st.size / 1048576).toFixed(1),
        createdAt: st.mtimeMs,
        // 没有元数据的一律当独立全量 —— 升级前做的备份就是这种
        type: meta ? meta.type : 'full',
        base: meta && meta.type === 'inc' ? meta.base : null,
        seq: meta && meta.type === 'inc' ? meta.seq : 0,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 恢复某份备份需要按顺序应用的文件列表。
 * 全量返回自己;增量返回 [全量, inc1, …, 自己]。
 * 链里缺环时返回 { error } —— 宁可明说"这份恢复不了",
 * 也不要解压出一个悄悄缺文件的世界。
 */
function restoreSequence(inst, id) {
  const all = listBackups(inst);
  const me = all.find((b) => b.id === id);
  if (!me) return { error: '备份不存在' };
  if (me.type === 'full') return { seq: [me] };
  const base = all.find((b) => b.id === me.base);
  if (!base) return { error: `增量备份缺少所属的全量备份(${me.base}),无法恢复` };
  const mids = all
    .filter((b) => b.type === 'inc' && b.base === me.base && b.seq <= me.seq)
    .sort((a, b) => a.seq - b.seq);
  // 序号必须连续:1,2,4 说明中间那份被删了,应用 1→2→4 会漏掉 3 里的改动
  for (let i = 0; i < mids.length; i++) {
    if (mids[i].seq !== i + 1) return { error: `增量链不完整(缺少第 ${i + 1} 个增量),无法恢复` };
  }
  return { seq: [base, ...mids] };
}

/**
 * 按保留策略清理旧备份(份数 + 天数,各自 0 表示不限)。
 * 只在备份成功后调用 —— 备份是唯一让这个目录变大的动作,
 * 在那一刻收一次就够,不用再养一个后台定时器。
 */
function pruneBackups(inst) {
  const { backupKeepCount, backupKeepDays } = settings.get();
  if (!backupKeepCount && !backupKeepDays) return [];
  const all = listBackups(inst);            // 已按 createdAt 倒序

  /* 按链分组再决定去留。
     链是恢复的最小单位 —— 删掉全量、留下它的增量,等于留下一堆恢复不了的
     文件,既占着磁盘又骗人。所以整条链一起判、一起删。
     全是独立全量时(升级前的老数据、或者从不用增量的人)每条链就一份,
     行为和原来完全一致。 */
  const chains = new Map();                 // fullId → { members[], newest }
  for (const b of all) {
    const key = b.type === 'inc' ? b.base : b.id;
    if (!chains.has(key)) chains.set(key, { members: [], newest: 0 });
    const c = chains.get(key);
    c.members.push(b);
    c.newest = Math.max(c.newest, b.createdAt);
  }
  // 按链里最新一份的时间倒序:一条还在持续追加增量的链算"新"
  const ordered = [...chains.values()].sort((a, b) => b.newest - a.newest);

  const doomedChains = new Set();
  if (backupKeepCount > 0) ordered.slice(backupKeepCount).forEach((c) => doomedChains.add(c));
  if (backupKeepDays > 0) {
    const cutoff = Date.now() - backupKeepDays * 86400000;
    // 整条链都过期了才删 —— 只要还有一份在保留期内,这条链就得完整留着
    for (const c of ordered) if (c.newest < cutoff) doomedChains.add(c);
  }
  // 最新的一条链永远留着:天数配得比备份间隔还短时,不能把刚做完的也删了
  if (ordered.length) doomedChains.delete(ordered[0]);

  const chainMeta = readChains(inst);
  const removed = [];
  for (const c of doomedChains) {
    for (const b of c.members) {
      try {
        fs.unlinkSync(path.join(backupDir(inst), b.id));
        delete chainMeta[b.id];
        removed.push(b.id);
      } catch (err) { inst.log('WARN', `[MCSP] 清理旧备份失败 ${b.id}: ${err.message}`); }
    }
    // 链没了,它的快照文件也该走 —— 否则 .snar 会一直堆着
    const fullId = c.members.find((m) => m.type === 'full');
    if (fullId) fs.rmSync(snarPath(inst, fullId.id), { force: true });
  }
  if (removed.length) {
    writeChains(inst, chainMeta);
    inst.log('INFO', `[MCSP] 已清理 ${removed.length} 份旧备份(保留策略:${backupKeepCount || '不限'} 份 / ${backupKeepDays || '不限'} 天,按增量链整条清理)`);
  }
  return removed;
}

/** 当前可追加增量的链:最近一次全量,且它的 .snar 还在 */
function activeChain(inst) {
  const all = listBackups(inst);
  const full = all.find((b) => b.type === 'full' && fs.existsSync(snarPath(inst, b.id)));
  if (!full) return null;
  const incs = all.filter((b) => b.type === 'inc' && b.base === full.id);
  return { full, nextSeq: incs.length + 1 };
}

/**
 * @param {string} name  备份名
 * @param {object} opts  { mode: 'full' | 'incremental' }
 */
function createBackup(inst, name, opts = {}) {
  return new Promise((resolve) => {
    const safe = String(name || `manual-${Date.now()}`).replace(/[^\w.-]+/g, '_').slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

    /* 决定这次到底做全量还是增量。三种情况会落回全量,而且都要说明白 ——
       用户以为在做增量、实际做了全量的话,磁盘规划就全错了。 */
    let mode = opts.mode === 'incremental' ? 'incremental' : 'full';
    let chain = null;
    if (mode === 'incremental') {
      if (!INCREMENTAL_OK) {
        inst.log('WARN', '[MCSP] 当前系统的 tar 不支持 --listed-incremental(需要 GNU tar),本次改做全量备份');
        mode = 'full';
      } else if (!(chain = activeChain(inst))) {
        inst.log('INFO', '[MCSP] 还没有可追加的全量备份,本次先做一次全量作为增量链的基准');
        mode = 'full';
      }
    }

    const suffix = mode === 'incremental' ? `.inc${chain.nextSeq}` : '';
    const out = path.join(backupDir(inst), `${safe}-${stamp}${suffix}.tar.gz`);
    const id = path.basename(out);

    // 全量开新链用自己的 id 作 snar 名;增量沿用所属全量的 snar(tar 会就地更新它)
    const fullId = mode === 'incremental' ? chain.full.id : id;
    const snar = snarPath(inst, fullId);
    const args = ['czf', out];
    if (INCREMENTAL_OK) {
      // 做全量时先删掉旧快照,否则 tar 会把它当成"接着上次"而打出一个空包
      if (mode === 'full') fs.rmSync(snar, { force: true });
      args.push(`--listed-incremental=${snar}`);
    }
    args.push('-C', inst.dir, '.');

    inst.log('INFO', `[MCSP] 开始${mode === 'incremental' ? `增量(第 ${chain.nextSeq} 个)` : '全量'}备份到 ${id}`);
    if (inst.proc) inst.command('save-all');
    const tar = spawn('tar', args);
    tar.on('exit', (code) => {
      if (code === 0) {
        const meta = readChains(inst);
        meta[id] = mode === 'incremental'
          ? { type: 'inc', base: chain.full.id, seq: chain.nextSeq }
          : { type: 'full' };
        writeChains(inst, meta);
        const sz = (() => { try { return +(fs.statSync(out).size / 1048576).toFixed(1); } catch { return 0; } })();
        inst.log('INFO', `[MCSP] 备份完成: ${id} (${sz} MB)`);
        pruneBackups(inst);
        resolve({ ok: true, id, mode, sizeMB: sz });
      } else {
        inst.log('ERROR', `[MCSP] 备份失败 (tar exit ${code})`);
        notify.emit('backupFailed', {
          title: `实例「${inst.name}」备份失败`,
          text: `tar 退出码 ${code}。目标文件 ${path.basename(out)} 已清理。`,
          dedupeKey: inst.id,
        });
        // 失败会留下半截的 tar.gz,不删掉它会一直占着保留份数
        fs.rmSync(out, { force: true });
        resolve({ ok: false, error: `tar 退出码 ${code}` });
      }
    });
  });
}

/**
 * 恢复前预览(功能 7)。
 *
 * 原来的恢复是一把梭:点下去直接 tar xzf 盖到实例目录上,盖之前谁也不知道
 * 这个包里到底有什么。备份文件名只有时间戳,选错一个(比如换服务端类型前
 * 那次自动备份)就把现在的世界盖没了,而且 tar 解压是覆盖式的,没法撤销。
 *
 * 所以先 tar tzf 列一遍:验证归档本身没坏(tar 能读完 = gzip 校验通过),
 * 统计有没有世界/插件,并挑出会被覆盖的现有文件。只读,不动磁盘。
 */
function inspectBackup(inst, id) {
  return new Promise((resolve) => {
    const file = path.join(backupDir(inst), id);
    if (!fs.existsSync(file) || !id.endsWith('.tar.gz')) return resolve({ ok: false, error: '备份不存在' });
    // -tzf 只读目录表;大包也就几秒,比解压便宜得多
    const tar = spawn('tar', ['tzf', file]);
    let out = '';
    let err = '';
    tar.stdout.on('data', (d) => { out += d; });
    tar.stderr.on('data', (d) => { err += d; });
    tar.on('error', (e) => resolve({ ok: false, error: `无法执行 tar: ${e.message}` }));
    tar.on('exit', (code) => {
      if (code !== 0) {
        // 这里失败基本等于包损坏 —— 正是要在覆盖之前发现的事
        return resolve({ ok: false, error: `归档无法读取,可能已损坏 (tar 退出码 ${code})${err ? ': ' + err.trim().slice(0, 200) : ''}` });
      }
      const entries = out.split('\n').map((s) => s.replace(/^\.\//, '').trim()).filter(Boolean);
      const files = entries.filter((e) => !e.endsWith('/'));
      // 顶层条目:用户认得出"这个包里有 world / plugins / server.properties"
      const top = [...new Set(entries.map((e) => e.split('/')[0]).filter(Boolean))].sort();
      const worlds = top.filter((t) => entries.some((e) => e.startsWith(`${t}/level.dat`)));
      // 会被盖掉的现有文件:只看顶层,逐个 stat 几万个文件不值当
      const overwrite = top.filter((t) => {
        try { return fs.existsSync(path.join(inst.dir, t)); } catch { return false; }
      });
      // 增量包里 tar 会塞一条 ./ 的目录清单条目,文件数会显得比直觉少 ——
      // 顺带把"这份要连着几个归档一起恢复"讲清楚
      const seq = restoreSequence(inst, id);
      resolve({
        ok: true,
        fileCount: files.length,
        topLevel: top.slice(0, 200),
        worlds,
        hasPlugins: top.includes('plugins') || top.includes('mods'),
        hasProps: entries.some((e) => e === 'server.properties'),
        overwrite,
        type: (listBackups(inst).find((b) => b.id === id) || {}).type || 'full',
        chain: seq.error ? null : seq.seq.map((b) => b.id),
        chainError: seq.error || null,
      });
    });
  });
}

/**
 * 恢复。增量备份要按 全量 → inc1 → … → incN 的顺序逐个应用,
 * 顺序错了或少一环,得到的世界会是几个时间点的混合体 —— 比恢复失败更糟,
 * 因为它看起来是成功的。所以链不完整时直接拒绝,不做"尽力而为"。
 *
 * 解压增量必须带 --incremental:tar 靠它读归档里的目录清单,
 * 才能把"上次有、这次被删了"的文件真正删掉。不带的话删除不会被重放,
 * 恢复出来的目录里会残留早就该消失的文件。
 */
function restoreBackup(inst, id) {
  return new Promise((resolve) => {
    if (!id.endsWith('.tar.gz')) return resolve({ ok: false, error: '备份不存在' });
    const r = restoreSequence(inst, id);
    if (r.error) return resolve({ ok: false, error: r.error });
    const files = r.seq.map((b) => path.join(backupDir(inst), b.id));
    for (const f of files) if (!fs.existsSync(f)) return resolve({ ok: false, error: `缺少 ${path.basename(f)}` });

    const isChain = r.seq.length > 1;
    if (isChain) inst.log('INFO', `[MCSP] 从增量链恢复,共 ${files.length} 个归档,按顺序应用`);

    let i = 0;
    const step = () => {
      if (i >= files.length) {
        inst.log('INFO', `[MCSP] 已从 ${id} 恢复`);
        return resolve({ ok: true, applied: r.seq.map((b) => b.id) });
      }
      const f = files[i];
      const args = ['xzf', f, '-C', inst.dir];
      if (isChain || readChains(inst)[path.basename(f)]) args.push('--incremental');
      const tar = spawn('tar', args);
      let err = '';
      tar.stderr.on('data', (d) => { err += d; });
      tar.on('exit', (code) => {
        if (code !== 0) {
          inst.log('ERROR', `[MCSP] 恢复中断于 ${path.basename(f)} (tar ${code})`);
          return resolve({ ok: false, error: `恢复 ${path.basename(f)} 失败 (tar 退出码 ${code})${err ? ': ' + err.trim().slice(0, 200) : ''}` });
        }
        if (isChain) inst.log('INFO', `[MCSP]   ✓ ${path.basename(f)} (${i + 1}/${files.length})`);
        i++;
        step();
      });
    };
    step();
  });
}

module.exports = {
  backupDir, listBackups, createBackup, restoreBackup, inspectBackup, pruneBackups,
  restoreSequence, INCREMENTAL_OK,
};
