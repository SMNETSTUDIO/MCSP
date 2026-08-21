#!/usr/bin/env bash
#
# MCSP 一键安装脚本(服务器上直接一行运行)
#
# 从 GitHub 拉取最新源码 → 交给 deploy.sh 自动完成:
#   Node.js 缺失时自动安装(用户目录,无需 root)→ 装依赖 → PM2 常驻 → 健康检查
#
# 用法(任选其一):
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/SMNETSTUDIO/MCSP/main/scripts/install.sh)"
#   curl -fsSL https://raw.githubusercontent.com/SMNETSTUDIO/MCSP/main/scripts/install.sh | bash
#   wget -qO-  https://raw.githubusercontent.com/SMNETSTUDIO/MCSP/main/scripts/install.sh | bash
#
# 参数(追加在 curl|bash 之后):
#   --dir ~/mcsp     安装目录(默认 ~/mcsp)
#   --branch main    分支(默认 main)
#   --port 8080      端口(透传给 deploy.sh)
#   --foreground     前台运行(调试,透传给 deploy.sh)
#
set -euo pipefail

REPO="SMNETSTUDIO/MCSP"
BRANCH="main"
DEST="${HOME}/mcsp"

# ---------- 输出辅助 ----------
c_reset='\033[0m'; c_green='\033[32m'; c_yellow='\033[33m'; c_red='\033[31m'; c_cyan='\033[36m'
say()  { printf "${c_cyan}▸ %s${c_reset}\n" "$*"; }
ok()   { printf "${c_green}✔ %s${c_reset}\n" "$*"; }
warn() { printf "${c_yellow}⚠ %s${c_reset}\n" "$*"; }
die()  { printf "${c_red}✘ %s${c_reset}\n" "$*" >&2; exit 1; }

usage() { sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0; }

# ---------- 参数解析 ----------
DEPLOY_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dir)      DEST="${2:?--dir 需要目录}"; shift 2 ;;
    --dir=*)    DEST="${1#*=}"; shift ;;
    --branch)   BRANCH="${2:?--branch 需要分支名}"; shift 2 ;;
    --branch=*) BRANCH="${1#*=}"; shift ;;
    --port|--port=*|--foreground) DEPLOY_ARGS+=("$1"); shift ;;
    -h|--help)  usage ;;
    *) die "未知参数:$1(-h 查看用法)" ;;
  esac
done

# ---------- 环境检查 ----------
[ "$(uname -s)" = "Linux" ] || die "仅支持 Linux(指标依赖 /proc)"

fetch() { # fetch <url> <目标文件>
  if command -v curl >/dev/null 2>&1; then curl -fSL --progress-bar -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO "$2" "$1"
  else die "需要 curl 或 wget 用于下载"
  fi
}

# ---------- 下载并解包源码 ----------
TARBALL="/tmp/mcsp-${BRANCH}.tar.gz"
URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"

mkdir -p "$(dirname "$DEST")"
if [ -d "$DEST/.git" ]; then
  say "目录 $DEST 已是 git 仓库,执行 git pull …"
  ( cd "$DEST" && git pull --ff-only ) || warn "git pull 失败,继续使用现有代码"
elif [ -f "$DEST/package.json" ]; then
  say "目录 $DEST 已存在 MCSP 源码,跳过下载"
else
  say "下载 ${REPO}#${BRANCH} …"
  fetch "$URL" "$TARBALL"
  say "解压到 $DEST …"
  mkdir -p "$DEST"
  tar -xzf "$TARBALL" -C "$DEST" --strip-components=1
  rm -f "$TARBALL"
  ok "源码就绪"
fi

[ -f "$DEST/scripts/deploy.sh" ] || die "$DEST 缺少 scripts/deploy.sh,源码不完整"

# ---------- 交给 deploy.sh ----------
say "进入部署阶段(目录:$DEST)…"
cd "$DEST"
exec bash scripts/deploy.sh "${DEPLOY_ARGS[@]}"
