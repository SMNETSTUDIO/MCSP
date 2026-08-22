# MCSP — MineCraft Server Panel
# Debian 基底(glibc):面板内一键安装的 Temurin JRE 需要 glibc,alpine/musl 不可用
FROM node:22-slim

# 运行期外部依赖:
#   tar/gzip        备份、穿透组件解包、文件管理器的 tar 家族打包/解压
#   bzip2/xz-utils  让 tar 认得 .tar.bz2 / .tar.xz(zip 是面板自己用 zlib 读写,不需要 unzip)
#   openssh-client  Pinggy / Serveo SSH 隧道(含 ssh-keygen)
#   util-linux      taskset(普通用户 CPU 配额绑核)
#   curl + ca-certificates  健康检查与官方源下载
#   procps          /proc 指标读取辅助
RUN apt-get update && apt-get install -y --no-install-recommends \
      tar gzip bzip2 xz-utils openssh-client util-linux curl ca-certificates procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖以利用构建缓存
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

# 预建数据目录并交给非 root 运行用户(卷初始化时继承该属主)
RUN mkdir -p data instances backups bin logs && chown -R node:node /app

# 数据全部落在这几个目录,挂卷即可持久化
VOLUME ["/app/data", "/app/instances", "/app/backups", "/app/bin", "/app/logs"]

ENV NODE_ENV=production \
    PORT=3000

EXPOSE 3000
# Minecraft 实例端口按需映射,例如 -p 25565:25565

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/api/health || exit 1

USER node
CMD ["node", "server.js"]
