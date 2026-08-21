/**
 * Java 运行时管理:按 MC 版本要求自动下载安装 Temurin JRE(Adoptium 官方源),
 * 面板托管于 bin/java/<major>/,实例启动时自动挑选匹配的版本。
 *
 * 版本要求(与 Mojang piston-meta 的 javaVersion 一致):
 *   MC ≥26(年份版本)→ Java 25;MC 1.20.5~1.21.x → Java 21;
 *   MC 1.17~1.20.4 → Java 17;MC ≤1.16 → Java 8
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');
const { BIN_DIR, JAVA_BIN } = require('./config');
const { downloadFile, runCmd } = require('./utils');
const bus = require('./bus');

const JAVA_DIR = path.join(BIN_DIR, 'java');
const MAJORS = [25, 21, 17, 8];                   // 面板托管的全部版本(覆盖所有 MC 版本)
const JAVA_ARCH = os.arch() === 'arm64' ? 'aarch64' : 'x64';

const javaInstalls = new Map(); // major -> progress %

function managedBin(major) { return path.join(JAVA_DIR, String(major), 'bin', 'java'); }

/** 系统 java(PATH 或 $JAVA_BIN)的版本首行与主版本号,失败返回 null */
function systemJava() {
  try {
    const line = execSync(`${JAVA_BIN} -version 2>&1`, { timeout: 5000 }).toString().split('\n')[0];
    const m = line.match(/version "(\d+)(?:\.(\d+))?/);
    let major = m ? parseInt(m[1], 10) : 0;
    if (major === 1) major = parseInt(m[2], 10) || 0;   // "1.8.0_402" → 8
    return { line, major };
  } catch { return null; }
}

/** MC 版本 → 需要的 Java 主版本;传 null 表示"越新越好"(代理等不挑版本的组件) */
function requiredMajor(mcVersion) {
  if (mcVersion == null) return MAJORS[0];
  const v = String(mcVersion).split('.').map((n) => parseInt(n, 10) || 0);
  const ge = (a, b, c = 0) => v[0] > a || (v[0] === a && ((v[1] || 0) > b || ((v[1] || 0) === b && (v[2] || 0) >= c)));
  if (v[0] >= 26) return 25;        // 2026 起 MC 使用年份版本号
  if (ge(1, 20, 5)) return 21;
  if (ge(1, 17)) return 17;
  return 8;
}

/** 各主版本可接受的系统 Java 区间(旧核心跑新 Java 会崩,新核心跑旧 Java 起不来) */
const COMPAT = { 25: [25, 99], 21: [21, 99], 17: [17, 21], 8: [8, 16] };

/**
 * 为实例挑选 Java:托管的精确版本 → 兼容区间内的系统 Java → 兼容的其他托管版本
 * → 兜底 JAVA_BIN(可能失败,但错误会显示在实例控制台)
 */
function resolveJavaBin(mcVersion) {
  const req = requiredMajor(mcVersion);
  if (fs.existsSync(managedBin(req))) return managedBin(req);
  const [lo, hi] = COMPAT[req];
  const sys = systemJava();
  if (sys && sys.major >= lo && sys.major <= hi) return JAVA_BIN;
  for (const m of MAJORS) {
    if (m >= lo && m <= hi && fs.existsSync(managedBin(m))) return managedBin(m);
  }
  return JAVA_BIN;
}

function javaInfo() {
  const sys = systemJava();
  return {
    arch: JAVA_ARCH,
    system: sys,
    majors: MAJORS.map((m) => ({
      major: m,
      installed: fs.existsSync(managedBin(m)),
      installing: javaInstalls.has(m),
      progress: javaInstalls.get(m) || 0,
    })),
  };
}

/** 从 Adoptium 下载 Temurin JRE 并解压到 bin/java/<major>/ */
async function installJava(major) {
  if (!MAJORS.includes(major)) throw new Error(`不支持的 Java 版本: ${major}`);
  if (javaInstalls.has(major)) throw new Error(`Java ${major} 正在安装中`);
  if (fs.existsSync(managedBin(major))) return;
  javaInstalls.set(major, 0);
  bus.broadcast('java', javaInfo());
  const notify = (pct) => {
    javaInstalls.set(major, pct);
    if (pct % 5 === 0) bus.broadcast('java', javaInfo());
  };
  const tmp = path.join(JAVA_DIR, `.java-${major}.tar.gz`);
  const tmpDir = path.join(JAVA_DIR, `.extract-${major}`);
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const url = `https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/${JAVA_ARCH}/jre/hotspot/normal/eclipse`;
    await downloadFile(url, tmp, notify);
    await runCmd('tar', ['xzf', tmp, '-C', tmpDir]);
    const inner = fs.readdirSync(tmpDir).find((d) => fs.existsSync(path.join(tmpDir, d, 'bin', 'java')));
    if (!inner) throw new Error('压缩包内未找到 java 可执行文件');
    fs.rmSync(path.join(JAVA_DIR, String(major)), { recursive: true, force: true });
    fs.renameSync(path.join(tmpDir, inner), path.join(JAVA_DIR, String(major)));
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
    javaInstalls.delete(major);
    bus.broadcast('java', javaInfo());
  }
}

/** 一键安装:补齐所有缺失的托管版本(逐个下载,进度经 SSE 广播) */
async function installAllJava() {
  const missing = MAJORS.filter((m) => !fs.existsSync(managedBin(m)) && !javaInstalls.has(m));
  for (const m of missing) await installJava(m);
  return javaInfo();
}

/** 总览页展示用:优先系统 java,否则最高的托管版本 */
function bestJavaVersionLine() {
  const sys = systemJava();
  if (sys) return sys.line;
  for (const m of MAJORS) {
    if (fs.existsSync(managedBin(m))) {
      try {
        return execSync(`"${managedBin(m)}" -version 2>&1`, { timeout: 5000 }).toString().split('\n')[0];
      } catch {}
    }
  }
  return null;
}

module.exports = { requiredMajor, resolveJavaBin, javaInfo, installJava, installAllJava, bestJavaVersionLine };
