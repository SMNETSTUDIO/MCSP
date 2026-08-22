# MCSP 架构说明

## 总览

```
浏览器(public/,原生 JS SPA)
   │  REST + SSE(Cookie 会话)
   ▼
server.js(入口,10 行)
   └─ src/app.js(Express 装配:中间件 → 路由 → SSE → 静态页 → 错误兜底)
        ├─ src/auth.js        认证与用户(scrypt、持久化会话、限速、双角色)
        ├─ src/routes/
        │    ├─ users.js      /api/users            用户管理(admin)
        │    ├─ host.js       /api/host /api/servertypes /api/java  宿主机、服务端类型/版本、Java 运行时
        │    ├─ tunnel.js     /api/tunnel/components 穿透组件安装
        │    └─ instances.js  /api/instances/**      实例 CRUD 及全部子资源
        ├─ src/registry.js    实例注册表 + 服务端下载安装/重装流程(含 Forge/NeoForge 安装器)+ 指标轮询
        ├─ src/instance.js    Instance 类(核心领域对象,见下)
        ├─ src/tasks.js       计划任务存储 + 30s 调度器
        ├─ src/backups.js     tar.gz 备份/恢复
        ├─ src/archive.js     压缩包:zip 用 zlib 自读写,tar 家族调系统 tar(均先做安全校验)
        ├─ src/disk.js        磁盘用量:分区 statfs + 每实例体积后台缓存(60s)
        ├─ src/notify.js      告警推送:通用 Webhook / Discord / Telegram(去重 + 永不抛错)
        ├─ src/audit.js       操作审计:写操作通用中间件 + JSONL 落盘 + 滚动
        ├─ src/modrinth.js    Modrinth 搜索/安装(loader 映射 + SHA-1 校验)
        ├─ src/tunnels.js     隧道组件下载(ngrok/frpc/playit/bore)+ SSH 密钥
        ├─ src/servertypes.js 服务端类型注册表:10 种官方下载源(1h 版本缓存)
        ├─ src/java.js        Java 运行时管理:Temurin 25/21/17/8 下载 + 按 MC 版本挑选
        ├─ src/mcping.js      Minecraft status ping(连通性验证)
        ├─ src/bus.js         SSE 事件总线
        ├─ src/utils.js       工具(下载、JSON 读写、ANSI 清洗、asyncHandler…)
        └─ src/config.js      路径与常量(启动时创建 data/instances/backups/bin)
```

依赖方向自上而下,无循环:routes → (registry, tasks, backups, tunnels) → instance → (tunnels, mcping, bus, utils, config)。

## 核心领域对象:Instance(src/instance.js)

一个 Instance = `instances/<id>/` 下的真实服务端目录 + 最多两个子进程:

- **服务端进程**:`java -Xmx… -jar server.jar nogui`(新版 Forge/NeoForge 为 `java @libraries/…/unix_args.txt`)
  - 额外 JVM 参数(`jvmArgs`)接在默认值之后 —— 同名 flag HotSpot 取最后一个,所以用户能盖掉默认;
    写了 `-Xms` 就不再发默认的 `-Xms512M`。校验拒绝 `-Xmx`/`MaxHeapSize`/`MaxRAMPercentage`
    (内存配额就是靠 `-Xmx` 落地的,放行等于让普通用户自己改配额)与 `-jar`/`-cp`/`@file`
    (会改变到底启动了什么)。参数进的是 `spawn` 的 argv 数组、不过 shell,没有命令注入面
  - stdout/stderr 按行解析:`Done (…s)!` → running;`joined/left the game` → 玩家表
  - `spawn` 本身失败(最常见:没装 Java,ENOENT)时 Node 不保证还会发 `'exit'`,
    所以 `'error'` 回调里要在 `proc.pid` 为空时自己收尾 —— 否则实例永远卡在
    `starting`,既停不掉也起不来
  - stop = stdin 写 `stop`(优雅存档),30s 超时 SIGKILL;exit 事件统一复位状态
  - **崩溃自动重启**:退出码非 0 且不是 stop/kill/面板关停引起的,5s 后自动拉起。
    10 分钟内超过 3 次就置 `autoRestartBlocked` 停手 —— 端口占用、jar 损坏这类
    "起来就死"的故障否则会无限重启,还会把真正的报错顶出日志缓冲区。
    退出码 0 不重启:那是有人在控制台敲了 `stop`,别跟他对着干。
    `app.js` 的 `shutdown()` 必须先置 `panel.shuttingDown`,否则面板正关着还在往回拉服
  - **面板重启后恢复**:`wasRunning` 随 start/stop/kill 持久化进注册表(崩溃退出时**不**翻转,
    所以"崩了之后面板也挂了"仍会被拉回来);面板监听端口后 `resumeInstances()` 把
    `autoStart && wasRunning` 的实例每 5s 拉起一个。用户主动停掉的实例 `wasRunning=false`,
    不会因为面板重启又自己跑起来
  - **启动前查端口**:同面板实例撞端口能报出是哪个实例;本机其它进程占用则读
    `/proc/net/tcp{,6}` 的 LISTEN 项判定(不用试 bind —— 那是异步的,而 `start()`
    同步返回)。不查也能起,但 BindException 埋在 Java 栈里,还会触发崩溃自动重启反复撞
  - CPU/RSS 每 2s 从 `/proc/<pid>/stat|status` 采样,两档保留:秒级 150 点(≈5 分钟,实时曲线)+
    分钟级 1440 点(24 小时)。分钟档同时存均值**和峰值** —— 只存均值会把瞬时尖峰抹平,
    而排查 OOM 时要看的恰恰是尖峰。都在内存,面板重启即丢
- **隧道进程**(独立于服务端,重启实例不断线):ngrok / frpc / playit / bore /
  Pinggy / Serveo 六种驱动,统一输出解析(`\r`/`\n` 双分隔 + ANSI 清洗),
  公网地址就绪后 4s 自动做一次 mcPing 连通性验证,失败原因写入 `tunnelError`

状态经 `snapshot()` 序列化,通过 SSE `state` 事件推送;所有状态变更点都调用
`emitState()`,前端无需轮询。

## 重装 / 升级(registry.js `reinstallInstance`)

只换服务端本体,世界、插件/模组、`server.properties` 原样保留 —— 和 `installInstance`
的关键区别就是**不碰 server.properties**:那里面是用户攒下来的全部配置,
按模板重写一遍等于清空。

`type`/`version` 在下载成功之后才写回,所以失败时实例仍是旧版本、照常能启动。
旧 jar 改了名才删(避免目录里堆历史版本)。代理换成服务端时补 `eula.txt` 与最小
`server.properties`,已存在则一概不动;按新类型的 `dataDir` 建 `plugins/` 或 `mods/`。
默认在动手前跑一次完整备份 —— MC 不支持世界降级,换版本可能是不可逆的。

## 常见配置文件入口(`GET /:iid/configs`)

按服务端类别给一份已知配置文件清单,**只列真实存在的**(不存在就不列,免得点开一片空文件);
Fabric/Forge 的模组配置数量不定,额外扫一层 `config/`。

故意**不做成表单**:这些 YAML 的键随服务端版本一直在变,硬编码字段迟早对不上,
不如把人直接送到已有的文本编辑器前面。

## 克隆(registry.js `cloneInstance`)

复制实例目录,换 id / 名字 / 端口。要求源实例已停止 —— 边跑边拷世界会拿到一份
撕裂的存档,而那种损坏往往要等玩家进服才暴露。

端口必须换(`findFreePort` 跳过其它实例已配的端口和当前 LISTEN 的端口),否则
两个实例永远只能开一个。隧道配置**不继承**:里面有 token 和固定远程端口,
两个实例同时用会互相打架。`logs/` `crash-reports/` `cache/` 不复制 —— 前两个是
上一个实例的历史,后者重新生成即可,整合包的 cache 可能有好几个 G。

## 磁盘用量(src/disk.js)

分区容量走 `fs.statfs`(用 `bavail` 而非 `bfree` —— 后者含 root 保留块,普通用户拿不到)。
每实例体积 = 实例目录 + 它的备份目录,要递归 stat 几万个文件,**不能在请求里现算**:
后台每 60s 串行扫一遍缓存,接口与配额检查都读缓存。代价是最长有一个扫描周期的滞后,
对"别把磁盘占满"这个目的够用;删大文件/备份后可以 `refresh(iid)` 立即重算。

**磁盘配额(`limits.maxDiskMB`,0 = 不限)**在五处强制:上传、解压、打包、备份、建实例。
只靠定时扫描是挡不住的 —— 用户能在两次扫描之间连传十几个大文件,每次读到的都是同一个
"还没超"的旧数字。所以写入成功后立刻 `bump()` 把增量记回缓存;`bump` 遇到缓存里
还没有的实例要**新建一条**而不是直接返回,否则刚创建的实例在第一次扫描前是配额盲区。
上传把剩余额度直接压进流式上限,超额当场断流,不用等收完几个 GB 再拒;
解压把额度压进 `extractArchive` 的 `maxBytes`,在任何字节落盘前就拒。

## 告警推送(src/notify.js)

五类事件:实例异常退出、重启风暴保护触发、备份失败、计划任务连续失败(≥3 次)、
宿主机磁盘 ≥90%。目标支持通用 Webhook(POST JSON)、Discord、Telegram,可分别开关。

三条硬约束:
- **永不影响主流程**:`emit()` 同步返回,内部 fire-and-forget,失败只写面板日志。
  备份已经失败了,不该再因为 webhook 超时炸第二次。
- **同事件同对象 5 分钟内只发一次**(`dedupeKey`),否则崩溃重启循环会把群刷爆。
- 目标地址发送前校验必须是 `http(s)`,挡掉 `file://` 之类,别把面板变成内网探测器。

## 在线安装插件/模组(src/modrinth.js)

选 Modrinth 是因为它有公开、免 key 的 v2 REST 接口,而且同一套接口同时覆盖
Bukkit 插件与 Fabric/Forge 模组 —— 面板两种实例都要用。(CurseForge 要申请 key,
SpigotMC 没有官方下载 API。)

搜索按实例的 loader(paper→paper/spigot/bukkit,fabric→fabric,…)与 MC 版本过滤,
搜出来的都是装得上的。安装前三道闸:文件名必须是规矩的 `.jar`、下载地址必须是
`cdn.modrinth.com`、**下完校验 SHA-1**。先写临时文件、校验通过才 rename ——
这是从公网往用户服务器里放可执行 jar,校验失败绝不能留下半截文件在 `plugins/` 等着被加载。

## 操作审计(src/audit.js)

做成**通用中间件**而不是逐路由手写:后者一定会漏,新增路由时也没人记得补。
代价是动作名要从 `method + path` 反推,所以有一张对照表,匹配不到就退化成 `METHOD /path`。

记在 `res.on('finish')` 里,所以**状态码一起记下来** —— 403/404 这类失败尝试同样留痕,
排查越权和暴力破解时那正是要看的。登录路由挂在 `requireAuth` 之前,用户名从 body 取,
失败的登录也有记录。GET 不记(否则日志全是刷新页面)。

`password` / `token` / `secret` 等字段递归替换成 `***` —— 审计日志本身不该成为凭据泄露点。
上传接口 body 是文件原始字节,只记 JSON 请求的参数。
落 `data/audit.log`,超过 `MCSP_AUDIT_MB`(默认 16)滚一次,只留一个 `.1`。

## 数据与持久化(data/,gitignore)

| 文件 | 内容 | 写入时机 |
|---|---|---|
| users.json | 用户(scrypt 哈希) | 用户增删改 |
| sessions.json | 会话 token(7 天 TTL) | 登录/登出,防抖 500ms |
| instances.json | 实例元数据 + 穿透配置 | 实例/配置变更 |
| tasks.json | 计划任务 | 任务变更、每次触发 |
| settings.json | 注册开关、公告、备份保留策略、告警推送配置 | 系统设置保存时 |
| audit.log(.1) | 操作审计 JSONL(含失败尝试) | 每个写请求结束时 |
| frpc-\<iid\>.toml / playit-\<iid\>.toml | 隧道进程配置/密钥 | 隧道启动/绑定 |
| ssh/id_ed25519(.pub) | SSH 类隧道专用密钥 | 首次使用时生成 |

实例本体(世界、jar、插件)在 `instances/`,备份在 `backups/`,穿透二进制在 `bin/`。

## 实时通道:SSE(/api/stream)

单一 EventSource,事件带 `iid` 由前端过滤:

`log`(控制台行)· `state`(实例快照)· `metrics`(CPU/RAM 采样点)·
`players` · `instances`(列表变化)· `tasks` · `components`(组件安装进度)

## 安全边界

- 全部 `/api`(除 health/auth/login)要求 HttpOnly Cookie 会话;admin 路由再叠 `requireAdmin`
- 文件 API 路径沙箱:`path.resolve` 后必须仍在实例目录内;在线编辑仅限文本扩展名 ≤2MB
- 上传是原始流(`POST …/files/upload`,body 即文件本身,不引 multipart 依赖):
  先写 `.mcsp-upload-*` 再 rename,中断不留半截文件;文件名必须单段(禁 `/` `\` `.` `..` 与控制字符),
  超过 `MCSP_MAX_UPLOAD_MB`(默认 2048)立即断流回 413
- 下载走同一个沙箱:文件用 `res.download` 原样回传,目录现 `tar czf -` 流式打包(不落盘、
  客户端断开即 SIGKILL 掉 tar);实例根目录不给下载,那是「备份」的活(会先 save-all)
- 备份 id 必须匹配 `^[\w.-]+\.tar\.gz$` —— Express 会解码 `:id`,不校验的话 `..%2F` 能带着
  `path.join` 走出 `backups/`(download/restore/delete 三处共用该校验)
- 解压(src/archive.js)把压缩包当**不可信输入**,落盘前整包体检:条目名含 `..` 拒绝、
  绝对路径夹回 dest 内(落地路径再校验一次)、**符号链接条目一律拒绝**、加密包拒绝、
  解压后总体积超 `MCSP_MAX_EXTRACT_MB`(默认 8192)拒绝。
  软链这条不能省:GNU tar 自己会挡 `..`,却挡不住「先解出 `esc -> /`,下次再往 `esc/` 里写」
  这种跨两次操作的逃逸 —— 多租户下那就是越过了实例隔离。
  tar 家族先 `tar -tvf` 列一遍清单做校验再 `-xf`(多一趟解压,换确定性);
  zip 是面板用 zlib 自己读写的,不依赖 `unzip`,顺带认 zip64 和没有 UTF-8 标志位的 GBK 文件名。
  同一实例的打包/解压串行(`archiveBusy`),打包先写 `.mcsp-archive-*` 再 rename
- 备份保留策略(`backupKeepCount` 份 / `backupKeepDays` 天,各自 0 为不限)在**每次备份成功后**
  执行一次,不另开定时器 —— 备份是唯一让 `backups/<iid>/` 变大的动作。两个条件取并集;
  最新的一份永远保留,否则天数配得比备份间隔还短时会把刚做完的那份也删掉。
  tar 失败留下的半截包会立即清掉,不然它会一直占着保留份数
- 登录限速(5 次失败锁 1 分钟);隧道配置输入全部白名单化清洗
- 全局错误中间件 + `asyncHandler`:异步路由抛错返回 500 JSON,不打崩进程

## 进程模型

PM2 **fork 模式**(见 ecosystem.config.js)。面板是有状态进程(会话、SSE 订阅、
子进程句柄),**不能**用 cluster 多副本。SIGTERM/SIGINT 时向所有子服发送
`stop` 落盘,8s 后退出。

## 测试

`npm test`(scripts/smoke.js)先在临时目录跑一遍压缩模块往返(打包 → 解压 → 逐字节比对 →
体积上限),再对运行中的面板做真实 API 回归:健康检查、鉴权边界(401/403/404)、
路径沙箱(上传/下载/解压/打包/重命名)、实例全部子资源读取。
