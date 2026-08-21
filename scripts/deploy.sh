#!/usr/bin/env bash
#
# MCSP 一键部署脚本
#
# 自动完成:环境检查 → 缺 Node 时自动安装(用户目录内,无需 root)
#          → 安装依赖 → PM2 常驻启动(或 --foreground 前台运行)→ 健康检查
# Java 不由脚本安装:登录面板后在「总览 → Java → 一键安装」下载(自动匹配版本)。
#
# 用法:
#   bash scripts/deploy.sh                 # 默认 3000 端口,PM2 常驻
#   bash scripts/deploy.sh --port 8080     # 自定义端口
#   bash scripts/deploy.sh --foreground    # 前台运行(调试用,不装 PM2)
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_VERSION_FALLBACK="v20.17.0"   # 缺 Node 时下载的官方版本

PORT=3000
FOREGROUND=0

# ---------- 输出辅助 ----------
c_reset='\033[0m'; c_green='\033[32m'; c_yellow='\033[33m'; c_red='\033[31m'; c_cyan='\033[36m'
say()  { printf "${c_cyan}▸ %s${c_reset}\n" "$*"; }
ok()   { printf "${c_green}✔ %s${c_reset}\n" "$*"; }
warn() { printf "${c_yellow}⚠ %s${c_reset}\n" "$*"; }
die()  { printf "${c_red}✘ %s${c_reset}\n" "$*" >&2; exit 1; }

usage() { sed -n '2,13p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

# ---------- 参数解析 ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --port)       PORT="${2:?--port 需要端口号}"; shift 2 ;;
    --port=*)     PORT="${1#*=}"; shift ;;
    --skip-java)  warn "--skip-java 已废弃(脚本不再安装 Java),忽略"; shift ;;
    --foreground) FOREGROUND=1; shift ;;
    -h|--help)    usage ;;
    *) die "未知参数:$1(-h 查看用法)" ;;
  esac
done
case "$PORT" in (*[!0-9]*|'') die "端口无效:$PORT" ;; esac

# ---------- 环境检查 ----------
[ "$(uname -s)" = "Linux" ] || die "仅支持 Linux(指标依赖 /proc)"

case "$(uname -m)" in
  x86_64)          ARCH_NODE=x64 ;;
  aarch64|arm64)   ARCH_NODE=arm64 ;;
  *) die "不支持的架构:$(uname -m)" ;;
esac

fetch() { # fetch <url> <目标文件>
  if command -v curl >/dev/null 2>&1; then curl -fSL --progress-bar -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "需要 curl 或 wget 用于下载"
  fi
}

# ---------- Node.js ≥ 18 ----------
node_major() { command -v node >/dev/null 2>&1 && node -v | sed 's/^v//' | cut -d. -f1 || echo 0; }

ensure_node() {
  if [ "$(node_major)" -ge 18 ]; then ok "Node.js $(node -v)"; return; fi
  # 官方 tarball 装到用户目录,免 root、不挑发行版
  local dir="$HOME/.local/node" tarball
  tarball="node-${NODE_VERSION_FALLBACK}-linux-${ARCH_NODE}.tar.xz"
  say "未找到 Node.js ≥ 18,下载官方 ${NODE_VERSION_FALLBACK} 到 ${dir} …"
  mkdir -p "$dir"
  fetch "https://nodejs.org/dist/${NODE_VERSION_FALLBACK}/${tarball}" "/tmp/${tarball}"
  tar -xJf "/tmp/${tarball}" -C "$dir" --strip-components=1
  rm -f "/tmp/${tarball}"
  export PATH="$dir/bin:$PATH"
  [ "$(node_major)" -ge 18 ] || die "Node.js 安装失败"
  # 写入 shell 配置,方便之后手动使用 node/pm2
  if [ -w "$HOME/.bashrc" ] && ! grep -q '.local/node/bin' "$HOME/.bashrc" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/node/bin:$PATH"  # MCSP deploy: node' >> "$HOME/.bashrc"
  fi
  ok "Node.js $(node -v) 已安装(${dir})"
}

# ---------- Java(只检测不安装:缺失时到面板总览页一键安装)----------
JAVA_DIR="$ROOT/bin/java"   # 面板「一键安装」的托管目录

java_major() { # java_major <java可执行文件>
  "$1" -version 2>&1 | sed -n 's/.*version "\([0-9]*\).*/\1/p' | head -1
}

find_java() { # 依次检查:$JAVA_BIN → PATH → 面板托管目录(高版本优先)
  local cand
  for cand in "${JAVA_BIN:-}" "$(command -v java 2>/dev/null || true)" \
              "$JAVA_DIR"/25/bin/java "$JAVA_DIR"/21/bin/java "$JAVA_DIR"/17/bin/java "$JAVA_DIR"/8/bin/java; do
    [ -n "$cand" ] && [ -x "$cand" ] || continue
    if [ "$(java_major "$cand" 2>/dev/null || echo 0)" -ge 8 ]; then
      echo "$cand"; return 0
    fi
  done
  return 1
}

ensure_java() {
  if JAVA_BIN="$(find_java)"; then
    export JAVA_BIN
    ok "检测到 Java $(java_major "$JAVA_BIN")($JAVA_BIN)"
  else
    warn "未检测到 Java —— 不影响面板运行;登录面板后在「总览 → Java → 一键安装」下载(按 MC 版本自动匹配 25/21/17/8)"
  fi
}

# ---------- 依赖安装 ----------
install_deps() {
  say "安装依赖(npm)…"
  cd "$ROOT"
  npm ci --omit=dev 2>/dev/null || npm install --omit=dev
  ok "依赖安装完成"
}

# ---------- 启动 ----------
health_check() {
  local i code
  for i in $(seq 1 15); do
    sleep 1
    code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/" 2>/dev/null || echo 000)"
    case "$code" in 200|302) return 0 ;; esac
  done
  return 1
}

start_foreground() {
  say "前台启动(Ctrl+C 退出)… http://localhost:${PORT}"
  cd "$ROOT"
  exec env PORT="$PORT" ${JAVA_BIN:+JAVA_BIN="$JAVA_BIN"} node server.js
}

start_pm2() {
  local PM2
  if command -v pm2 >/dev/null 2>&1; then PM2=pm2
  else
    say "安装 PM2 …"
    if npm install -g pm2 >/dev/null 2>&1; then PM2=pm2
    else warn "npm -g 安装失败(可能无权限),改用 npx pm2"; PM2="npx pm2"
    fi
  fi
  cd "$ROOT"
  say "PM2 启动(端口 ${PORT})…"
  # 用 env 传变量:展开产生的 KEY=VAL 不会被 bash 当作赋值前缀,直接写会被当命令执行
  env PORT="$PORT" ${JAVA_BIN:+JAVA_BIN="$JAVA_BIN"} $PM2 startOrRestart ecosystem.config.js --update-env
  $PM2 save >/dev/null 2>&1 || true

  if health_check; then
    ok "部署完成,面板运行正常"
  else
    $PM2 logs mcsp --lines 20 --nostream || true
    die "健康检查失败:http://localhost:${PORT} 无响应,请查看上方日志"
  fi

  printf "\n"
  printf "  ${c_green}⛏ MCSP 已部署${c_reset}\n"
  printf "    地址:     http://localhost:%s\n" "$PORT"
  printf "    默认账户:  admin / admin123 ${c_yellow}(请立即修改密码)${c_reset}\n"
  [ -n "${JAVA_BIN:-}" ] && printf "    Java:      %s\n" "$JAVA_BIN"
  printf "    常用命令:  %s logs mcsp | %s restart mcsp | %s stop mcsp\n" "$PM2" "$PM2" "$PM2"
  printf "    开机自启:  运行 '%s startup' 并按提示执行(需 sudo)\n" "$PM2"
  printf "\n"
}

# ---------- 主流程 ----------
say "MCSP 一键部署(目录:$ROOT)"
if [ "$(id -u)" = 0 ] && [ "$(stat -c %u "$ROOT")" != 0 ]; then
  warn "正在以 root 运行,而项目属于用户 $(stat -c %U "$ROOT");生成的文件将归 root 所有。本脚本不需要 sudo,建议用项目所属用户直接运行"
fi
ensure_node
ensure_java
install_deps
if [ "$FOREGROUND" = 1 ]; then start_foreground; else start_pm2; fi
