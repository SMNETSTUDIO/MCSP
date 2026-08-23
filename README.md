<div align="center">

# ⛏️ MCSP

**MineCraft Server Panel** · 像素风 / 液态玻璃双主题的 Minecraft 服务器管理面板

在自己的机器上开服:选好版本,面板从官方源下载服务端并拉起 `java -jar` 子进程 ——
控制台、玩家列表、CPU/内存曲线都来自这个进程本身。Java 不用预装,没有公网 IP 也能让朋友进服。

Run Minecraft servers on your own box: pick a version, MCSP fetches it from the official source
and starts a real `java -jar` child process — the console, player list and CPU/RAM charts all come
from that process. No Java pre-install, no public IP required.

10 种服务端 · 6 种内网穿透 · 一键装 Java · authlib-injector 外置登录 · 多租户配额<br>
10 server types · 6 tunnels · one-click Java · external auth · multi-tenant quotas

[功能 Features](#-功能-features) · [快速开始 Quick Start](#-快速开始-quick-start) · [架构 Architecture](#-架构-architecture) · [验收 Acceptance](#-验收-acceptance) · [许可证 License](#-许可证-license)

[![CI](https://github.com/SMNETSTUDIO/MCSP/actions/workflows/ci.yml/badge.svg)](https://github.com/SMNETSTUDIO/MCSP/actions/workflows/ci.yml) [![Docker](https://github.com/SMNETSTUDIO/MCSP/actions/workflows/docker.yml/badge.svg)](https://github.com/SMNETSTUDIO/MCSP/actions/workflows/docker.yml) [![community](https://github.com/user-attachments/assets/653f2b6b-ee32-4f0f-abe0-1ba96e4bb473)](https://linux.do/) [![Telegram Group](https://img.shields.io/badge/Telegram-Group-blue?logo=telegram&style=flat)](https://t.me/smnet_group/107110)

![style](https://img.shields.io/badge/style-pixel%20%2F%20liquid%20glass-blue) ![node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen) ![java](https://img.shields.io/badge/java-21%2B-orange) ![license](https://img.shields.io/badge/license-Apache%202.0-blue)

</div>

---

## ✨ 功能 Features

| 中文 | English |
|------|---------|
| 🔐 scrypt 哈希 + HttpOnly 会话 + **持久化**登录限速;**两步验证 TOTP**(自实现 RFC 6238,带一次性恢复码)、**API Token**(Bearer,存摘要)、**活跃会话管理**(看设备/踢单个/退出其它);**自定义 OAuth2 登录**(任意提供商,自动建号/绑定,state 防 CSRF) | scrypt hashing + HttpOnly sessions + login rate-limit; **custom OAuth2 login** (any provider, auto-register/bind, CSRF-safe state) |
| 🛡 **强制两步验证**(默认关):开启后没配 TOTP 的账号除了「账号安全」页什么都打不开,**管理员也一样** —— 只约束别人的安全策略没有意义。自己没启用 TOTP 时开关是禁用的(后端同样拒绝),策略开着也不许关掉自己的 TOTP:面板上**没有任何一条路径能把自己锁在门外**。API Token 不受影响,否则开启的瞬间所有脚本都会断 | 🛡 **Enforce 2FA** (off by default): accounts without TOTP can reach nothing but the account page — **admins included**, since a policy that exempts its author is theatre. The toggle is disabled (and rejected server-side) until *you* have TOTP, and you can't disable your own TOTP while the policy is on — so **no path locks you out of your own panel**. API tokens are exempt, or every script would break the moment you flip it |
| ✉ **一次性邀请链接**:不想开放注册、又不想手动建号把密码发到聊天记录里 —— 签发一条带**有效期和配额**的链接,用一次即失效。只能建普通用户(泄露的链接不该能拿到面板控制权),已用/过期的记录保留以便追溯谁邀请了谁 | ✉ **One-shot invite links**: neither open registration nor hand-made accounts with passwords pasted into chat — issue a link with an **expiry and a quota**, valid for exactly one signup. Invites can only create regular users (a leaked link must never yield panel control), and spent/expired ones are kept so you can trace who invited whom |
| 📦 10 种服务端官方源安装:Paper / Purpur / Folia / Vanilla / Fabric / Forge / NeoForge / Velocity / Waterfall / BungeeCord,新老版本全支持 | 10 server types from official sources; Forge/NeoForge run the official installer; legacy versions supported (Vanilla back to 1.2.5) |
| ⚙ 实例可**改名/换图标**、**换服务端类型 / 升降级 MC 版本**(世界·插件·配置全保留,重装前自动备份)、**一键克隆**(自动分配空闲端口);**自定义 JVM 参数**(一键填入 Aikar's Flags),`-Xmx` 仍由配额统一管控 | Rename/re-icon instances, **switch server type or MC version in place** (worlds, plugins and config all kept, auto-backup first), **one-click clone** (free port auto-assigned); **custom JVM flags** with one-click Aikar's Flags, while `-Xmx` stays under quota control |
| ☕ 面板内**一键安装 Java**(Temurin 25/21/17/8),按 MC 版本自动匹配运行时 | **One-click Java install** (Temurin 25/21/17/8), auto-matched to the MC version |
| 🎮 外置登录:**authlib-injector** 自动下载 + `-javaagent` 注入,对接 LittleSkin 等 Yggdrasil 皮肤站 | External auth: auto-downloaded **authlib-injector** injected via `-javaagent`, works with LittleSkin & any Yggdrasil API |
| ❯_ 控制台 = 真实 stdout 流(SSE)+ stdin 命令(↑↓ 历史、**Tab 补全**命令与在线玩家名);**全缓冲搜索 + 级别过滤 + 一键下载**(缓冲 5000 行,可用 `MCSP_LOG_LINES` 调);玩家页显示**真实皮肤头像 + UUID**,封禁/踢出可**带理由**并保留封禁时间与操作者;总览页支持**批量启停**;设置页可上传预览 **server-icon.png** | Console = real stdout stream (SSE) + stdin commands (history, **Tab-completion** for commands and online players); **search the whole buffer, filter by level, download as text** (5000-line buffer, tunable via `MCSP_LOG_LINES`); the player page shows **real skin avatars + UUIDs**, ban/kick take a **reason** (with ban time and operator kept); the overview has **bulk start/stop**; settings uploads and previews **server-icon.png** |
| ⇄ 六种内网穿透:**bore / playit.gg / Pinggy / Serveo / ngrok / frpc**,每实例独立隧道、公网地址自动解析;frpc 支持 **frps-panel** 多用户鉴权(user + metadatas.token) | 6 tunnels: **bore / playit.gg / Pinggy / Serveo / ngrok / frpc**, one tunnel per instance with auto-parsed public address; frpc supports **frps-panel** auth (user + metadatas.token) |
| ♻️ **崩溃自动重启**:进程异常退出 5 秒后自动拉起;10 分钟内连崩 3 次即停手告警,避免无限重启风暴。控制台手动 `stop`、点「停止/强杀」、面板自身关停均不触发 | ♻️ **Crash auto-restart**: relaunches 5s after an abnormal exit; gives up with an alert after 3 crashes in 10 min instead of restart-looping. Manual `stop`, the stop/kill buttons and panel shutdown never trigger it |
| ⏻ **面板重启后自动恢复**:只拉起面板停止时正在运行的实例,每 5 秒一个错峰启动;你主动停掉的不会自己跑起来 | ⏻ **Resume after panel restart**: brings back only the instances that were running when the panel went down, staggered 5s apart; anything you stopped on purpose stays stopped |
| 📊 指标采样自 `/proc/<pid>`:真实 CPU% / RSS 内存实时曲线,可切**近 24 小时**视图(分钟级聚合,画峰值);总览页显示**宿主机磁盘用量**与**各实例占用排行**(实例目录 + 备份分列)。宿主机那张卡**仅管理员可见** | Metrics sampled from `/proc/<pid>`: real CPU% / RSS with live charts; the overview shows **host disk usage** and a **per-instance breakdown** (instance dir vs. backups). The host card is **admin-only** |
| ⏱ **TPS / MSPT 监控**:CPU 满载不等于卡,CPU 空闲也不等于流畅 —— 一个插件卡住主线程能把 TPS 打到 5 而 CPU 曲线毫无异样。走 RCON 每 10 秒采一次,认 Paper / Purpur / Spigot 三种输出格式;**没开 RCON 就如实显示「需要 RCON」,不编一个 20.0 出来** | ⏱ **TPS / MSPT**: a pegged CPU doesn't mean lag and an idle one doesn't mean smooth — one plugin blocking the main thread drops TPS to 5 while the CPU chart looks fine. Sampled over RCON every 10s, parsing Paper / Purpur / Spigot formats; when RCON is off it **says so instead of inventing a 20.0** |
| 💥 **崩溃现场归档**:异常退出时存下面板日志最后 200 行 + 服务端 `crash-reports/` 里对应的那份报告。两样都要 —— 崩在启动阶段(端口占用、JVM 参数写错)根本没有 crash-report,而真正的 Java 堆栈只在 crash-report 里。**落盘保存,面板重启后仍查得到** | 💥 **Crash archive**: on an abnormal exit, keeps the last 200 console lines **plus** the matching `crash-reports/` file. Both matter — a crash during startup (port in use, bad JVM flags) produces no crash-report at all, while the real Java stack trace lives only there. **Persisted to disk, so it survives a panel restart** |
| 📜 **控制台日志落盘**:内存缓冲只有 5000 行且重启即失,而服务端自己的 `latest.log` 不含面板打的 `[MCSP]` 行(自动重启、配额拦截、隧道状态)—— 排查往往正卡在这些行上。写 `logs/mcsp-console.log`,超 16 MB 滚一份(`MCSP_LOG_FILE_MB` 可调) | 📜 **Console log to disk**: the in-memory buffer holds 5000 lines and dies with the panel, and the server's own `latest.log` lacks the panel's `[MCSP]` lines (auto-restart, quota blocks, tunnel state) — which is often exactly what you need. Written to `logs/mcsp-console.log`, rotated past 16 MB (`MCSP_LOG_FILE_MB`) |
| ⏳ **玩家在线时长**:从进出服的日志累计每人总时长与会话数,按时长排行。进程退出时结算未闭合的会话 —— 否则这些人下次进服会被算成「从上次到现在一直在线」,凭空多出几天 | ⏳ **Playtime tracking**: total time and session count per player, ranked. Open sessions are settled when the process exits — otherwise a player would later be credited with all the time in between |
| ⌨ **RCON 支持**:开了 `enable-rcon` 就走 RCON(能拿到命令**输出**,服务端卡死时也是独立通道),不通自动回落 stdin;面板可一键开启并生成随机密码 | ⌨ **RCON**: used automatically when `enable-rcon` is on — it returns the command's **output** and stays usable when the server's main thread is stuck; falls back to stdin on any error, and the panel can enable it with a generated password |
| ⤓ **在线装插件/模组**:面板内搜 **Modrinth**,按当前服务端类型与 MC 版本过滤,选版本一键装到 `plugins/` 或 `mods/`,**下载后校验 SHA-1**;列表可直接删除 | ⤓ **Install from Modrinth in-panel**: filtered by your server type and MC version, one click into `plugins/` or `mods/`, **SHA-1 verified** after download; delete straight from the list |
| 🗎 设置页列出**这个实例真实存在的常见配置文件**(bukkit/spigot/paper-global/velocity.toml、Fabric-Forge 的 `config/*`),点一下直达编辑器 | Settings lists the config files that **actually exist** for this instance (bukkit/spigot/paper-global/velocity.toml, `config/*` for Fabric & Forge) — one click opens the editor |
| 🗀 文件管理器(路径沙箱):在线编辑 + **拖拽/多选上传**(实时进度条)+ **文件下载 / 目录打包 tar.gz 下载** + 重命名、✦ 插件/模组启停(`.jar ⇄ .jar.disabled`,按服务端类型自动认 `plugins/` 或 `mods/`)、◍ 世界管理(**列出所有存档**、切换当前世界、新建带种子的世界、删除旧存档;正在用的世界不给删)、◷ 计划任务(**如实记录每次执行结果**:成功/失败/因状态不匹配而跳过,连续失败会累计并标红) | Sandboxed file manager: online editing + **drag-and-drop / multi-file upload** with live progress + **file download / folder download as tar.gz** + rename, plugin/mod toggle (`.jar ⇄ .jar.disabled`, auto-targets `plugins/` or `mods/` per server type), world management (**list every save**, switch the active world, create one with a seed, delete old ones — the in-use world is protected), scheduled tasks that **record what actually happened** (success / failure / skipped-because-wrong-state, with a consecutive-failure counter) |
| 🗜 **压缩包**:勾选任意文件/目录打包成 **zip / tar.gz**,整合包与世界包一键**解压**(zip / mrpack / tar / tar.gz / tar.bz2 / tar.xz)。zip 由面板用 zlib 自己读写(不装 unzip 也能用,认 GBK 文件名与 zip64),解压前先拦截 `..`、软链、加密包与 zip bomb | 🗜 **Archives**: pack any selection into **zip / tar.gz**, one-click **extract** for modpacks & world packs (zip / mrpack / tar / tar.gz / tar.bz2 / tar.xz). ZIP is read/written in-process with zlib — no `unzip` needed, handles GBK names and zip64 — and every archive is screened for `..`, symlinks, encryption and zip bombs before a single byte lands |
| 🔔 **告警推送**:实例崩溃 / 重启风暴 / 备份失败 / 任务连崩 / 磁盘告急,推到**通用 Webhook · Discord · Telegram**;同事件 5 分钟去重,推送失败绝不影响实例 | 🔔 **Alerts** for crashes, restart storms, failed backups, repeatedly failing tasks and low disk — to a **generic webhook, Discord or Telegram**; deduped per 5 min, and a failing webhook never affects the server |
| ⧉ 真实 `tar.gz` 备份/恢复/**下载**,备份前自动 `save-all`;**保留策略**(默认留 10 份 / 30 天,可在系统设置调整或关闭)每次备份后自动清理旧包,磁盘不会被无声占满 | Real `tar.gz` backup / restore / **download**, with automatic `save-all`; **retention** (10 copies / 30 days by default) prunes old archives after every backup so the disk never silently fills |
| ⧗ **增量备份**(GNU tar `--listed-incremental`):一条链 = 1 全量 + N 增量,几十 GB 的世界不必每天整抄一遍。恢复增量会**按顺序自动应用整条链**并重放删除;链缺环时明确拒绝而不是解出一个半新半旧的世界;保留策略**按链整条清理**,不会删掉全量留下一堆恢复不了的增量 | ⧗ **Incremental backups** via GNU tar `--listed-incremental`: a chain is 1 full + N increments, so a 50 GB world isn't copied in full every night. Restoring an increment **replays the whole chain in order** (including deletions), refuses outright if a link is missing rather than producing a half-old world, and retention **prunes by chain** so a full is never deleted out from under its increments |
| ☁ **异地备份**:每次备份成功后在**后台**同步一份到 **S3 兼容存储 / WebDAV / rclone**(按 `<实例 ID>/<文件名>` 分目录)。SigV4 手写、**零第三方依赖**;**上传失败绝不影响本地备份**,只告警 —— 本地那份已经做完了 | ☁ **Off-box backups**: every successful backup is mirrored **in the background** to **S3-compatible storage / WebDAV / rclone**, foldered by `<instance id>/<file>`. SigV4 is hand-rolled — **no third-party dependency** — and **a failed upload never affects the local backup**, it only raises an alert |
| 🔍 **恢复前预览**:恢复是覆盖式且不可撤销,而备份名只有个时间戳 —— 点「恢复」先列出包内文件数、世界、插件目录,以及**哪些现有内容会被覆盖**;顺带验证归档完整性,损坏的包在覆盖任何东西之前就被拦下 | 🔍 **Pre-restore preview**: restores overwrite irreversibly and backup names are just timestamps — so the confirm dialog lists the file count, worlds, plugin dirs and **exactly which existing paths will be overwritten**. It also verifies archive integrity, so a corrupt archive is caught before a single byte is overwritten |
| 🕵 **操作审计**:谁在什么时候动了什么,**含失败尝试**(403/404/登录失败);口令类字段自动脱敏,管理员在系统设置页可筛选查看 | 🕵 **Audit log**: who did what and when, **including failed attempts** (403/404/bad logins); credential fields auto-redacted, filterable by admins |
| 🤝 **实例共享 + 三档权限**:把实例分享给其他面板用户,每人独立设 **只读**(看状态·日志·玩家)/ **运维**(+ 启停·命令·建备份·踢人封禁)/ **管理**(除下面两条外同主人)。任何一档都**不能删实例、不能改名单**;配额始终算在主人头上 | 🤝 **Share an instance** with a **per-collaborator permission tier**: **viewer** (status, logs, players), **operator** (+ start/stop, console commands, backups, kick/ban) or **manager** (everything but the two below). No tier can **delete the instance or edit the collaborator list**; quota always counts against the owner |
| ◉ 多租户:普通用户实例**隔离**,配额真实生效——实例数 / 内存(-Xmx 之和)/ CPU 核(taskset 绑核)/ **磁盘**(实例目录 + 备份,上传·解压·打包·备份五处校验) | Multi-tenant: isolated user instances with enforced quotas — instance count / memory (Σ-Xmx) / CPU cores (taskset pinning) / **disk** (instance dir + backups, enforced on upload, extract, pack and backup) |
| 🎚 **阈值可配置**:磁盘告警线、崩溃计数窗口 / 次数 / 重启延迟,原先是源码常量,改一次要重启面板。重度模组服启动慢又崩得勤,固定「10 分钟 3 次」会被误判成重启风暴而停手 —— 这本来就该按部署调。存完下一次判断即生效 | 🎚 **Tunable thresholds**: disk-warning level and the crash window / count / restart delay used to be source constants. A heavy modded server is slow to boot and crashes more often, so a fixed "3 in 10 min" gets misread as a restart storm — this belongs in config. Changes apply on the next check, no restart |
| 💾 **面板配置导出 / 导入**:打包 `settings` / `users` / `instances` / `tasks` / `oauth` 五个 JSON,换机器或误删时用。导入前强制干跑校验(格式、版本、**包里至少有一个管理员**),写入前把现有文件另存为 `.bak-<时间戳>`。不含会话与审计日志 —— 那是「这台机器发生过什么」,搬家没有意义 | 💾 **Panel config export / import**: bundles `settings` / `users` / `instances` / `tasks` / `oauth` for migration or recovery. Import is dry-run validated first (format, version, **at least one admin in the bundle**) and backs up existing files as `.bak-<ts>` before writing. Sessions and the audit log are excluded — those describe *this* machine and don't travel |
| ⬆ 侧栏显示**面板版本**并可点击**检查更新**(比对 GitHub 最新 tag);查不到时如实显示「更新状态未知」而不是假装最新 | ⬆ The sidebar shows the **panel version** and checks for updates against the latest GitHub tag — and says "unknown" when it can't reach it rather than pretending you're current |
| 🎨 双主题:像素风(Minecraft GUI 质感)/ Apple 液态玻璃;深浅色、6 主题色、密度可调 | Two themes: pixel (Minecraft GUI) / Apple liquid glass; dark/light, 6 accent colors, density options |

## 🚀 快速开始 Quick Start

### 一行安装 One-Line Install

服务器(或 VPS)上直接复制运行,自动拉取源码 → 装 Node → 装依赖 → PM2 常驻:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SMNETSTUDIO/MCSP/main/scripts/install.sh)"
```

自定义安装目录 / 端口:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/SMNETSTUDIO/MCSP/main/scripts/install.sh)" -- --dir ~/mcsp --port 8080
```

### Docker 一键部署 One-Click Deploy

```bash
docker compose up -d --build
# 或直接使用镜像 or use the prebuilt image
docker run -d --name mcsp -p 3000:3000 -p 25565:25565 \
  -v mcsp-data:/app/data -v mcsp-instances:/app/instances \
  -v mcsp-backups:/app/backups -v mcsp-bin:/app/bin \
  ghcr.io/smnetstudio/mcsp:latest
```

打开 / Open `http://localhost:3000`,默认账户 / default account **`admin` / `admin123`**(请立即修改 / change it immediately)。

### 一键脚本 Script Deploy

```bash
bash scripts/deploy.sh                 # 自动装 Node(缺失时)→ 装依赖 → PM2 常驻 → 健康检查
bash scripts/deploy.sh --port 8080     # 自定义端口 custom port
bash scripts/deploy.sh --foreground    # 前台运行(调试)foreground (debug)
```

### 手动启动 Manual

```bash
# 依赖 Requirements: Node.js ≥ 18, Linux(指标读取 /proc)
npm install
npm start                    # http://localhost:3000
npm run pm2                  # 或 PM2 常驻 or run under PM2
```

- **Java 无需预装**:登录面板 → 总览 → Java →「⬇ 一键安装」,自动下载 Temurin 25/21/17/8 到 `bin/java/`,实例启动按 MC 版本自动匹配(26+ → 25,1.20.5+ → 21,1.17+ → 17,≤1.16 → 8)
  **No Java pre-install needed**: install Temurin from the Overview page; the runtime is auto-matched per MC version.
- 创建实例:总览 →「＋ 新建实例」→ 选版本、勾选 EULA → 自动下载安装 → 启动
- 外置登录:实例 → 设置 → 打开「外置登录」并填 Yggdrasil API(如 `https://littleskin.cn/api/yggdrasil`)
  External auth: Instance → Settings → enable and fill the Yggdrasil API URL.

## 🧱 架构 Architecture

```
浏览器 Browser ──► Express(server.js + src/)──► spawn(java -jar server.jar)× N 实例
                    │  SSE 日志/状态流 log & state stream       │ stdout 解析 / stdin 命令
                    │                                           └► /proc/<pid> 指标 metrics
                    └► 每实例独立隧道进程 per-instance tunnel(bore / playit / Pinggy / Serveo / ngrok / frpc)

src/
  app.js 装配 · auth.js 认证 · oauth.js OAuth2 · instance.js 核心领域对象
  registry.js 注册表 · tasks.js 调度 · backups.js 备份(全量 + 增量链)· tunnels.js 穿透组件
  authlib.js 外置登录 · archive.js 压缩包(zip 自读写 / tar 调系统 tar)
  remotebackup.js 异地备份(S3 SigV4 手写 / WebDAV / rclone)
  invites.js 邀请链接 · playtime.js 在线时长 · panelbackup.js 面板配置导出导入
  routes/  users / host / tunnel / instances
public/    原生 JS 前端,零依赖 vanilla JS frontend, zero deps
```

权限模型 Permission model:

```
面板角色 panel role   admin ─────────────── 全部实例 + 用户管理 + 系统设置
                     user  ─────────────── 自己的实例(配额受限 quota-bound)

实例内 per-instance   owner ─────────────── 含删实例 / 改协作者名单
                     manager ───────────── 除上面两条外同 owner
                     operator ──────────── 启停 · 命令 · 备份 · 踢人封禁
                     viewer ────────────── 只读 read-only
```

进程生命周期:`spawn(java …)` → 解析 stdout(`Done (…)!` 判定 running,joined/left 维护玩家表)→ `stop` 写 stdin 优雅关闭(30s 超时强杀)→ exit 复位。面板退出时向所有子进程发送 stop,保证世界落盘。

详见 / See [ARCHITECTURE.md](ARCHITECTURE.md)。

## 📁 仓库结构 Repository Structure

```
server.js              入口 entry (10 lines)
src/                   后端分层模块 backend modules
public/                前端 frontend(vanilla JS)
scripts/deploy.sh      一键部署 one-click deploy
scripts/smoke.js       npm test — 110 项冒烟回归 smoke suite(压缩往返 + 实例级 + 多租户/权限边界)
instances/<id>/        每实例一个真实服务端目录 real server dir per instance
  └ logs/mcsp-console.log  控制台日志落盘 persisted console log(16 MB 轮转 rotated)
backups/<id>/          真实备份 real backups
  ├ *.tar.gz               全量与增量包 full & incremental archives
  ├ .mcsp-chains.json      增量链元数据 chain metadata(谁基于谁)
  └ .snar/                 GNU tar 增量快照 incremental snapshots
data/                  users / sessions / instances / tasks / invites / crashes / playtime(持久化 persisted)
Dockerfile             容器镜像 container image(node:22-slim + tar/bzip2/xz/ssh/taskset)
ecosystem.config.js    PM2 配置 PM2 config(fork + JAVA_BIN)
```

## ✅ 验收 Acceptance

```bash
npm test          # scripts/smoke.js — 压缩模块本地往返 + 对运行中的面板做真实 API 回归
                  # archive round-trip + real-API regression checks against a running panel
```

CI 在每次 push 时启动面板并跑完整冒烟;Docker 镜像由 Actions 构建并推送 GHCR。
CI boots the panel and runs the full smoke suite on every push; Docker images are built & pushed to GHCR by Actions.

## ⚠️ 提示 Notes

- 安装服务端时写入 `eula=true`,代表**你**同意 [Minecraft EULA](https://aka.ms/MinecraftEULA)(创建实例时需勾选确认)。
  Installing a server writes `eula=true`, meaning **you** accept the Minecraft EULA (confirmed at instance creation).
- 面板未内置 HTTPS/反代,公网部署请置于 Nginx/Caddy 之后并修改默认密码。
  No built-in HTTPS/reverse proxy — put it behind Nginx/Caddy and change the default password before going public.
- 内网穿透与外置登录组件(bore/frpc/ngrok/playit、authlib-injector)均从官方源下载,遵守各自服务条款。
  Tunnel & auth components are downloaded from official sources; comply with their respective terms.

## 📄 许可证 License

[Apache-2.0](LICENSE)

---

## 📈 项目增长 Project Growth

<p align="center">
  <a href="https://github.com/MacRimi/repo-growth">
    <img src="assets/repo-growth.svg" alt="Project growth" width="900">
  </a>
</p>

*由 [repo-growth](https://github.com/MacRimi/repo-growth) 每日自动更新 / Updated daily by repo-growth.*
