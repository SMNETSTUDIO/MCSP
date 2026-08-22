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
        ├─ src/registry.js    实例注册表 + 服务端下载安装流程(含 Forge/NeoForge 安装器)+ 指标轮询
        ├─ src/instance.js    Instance 类(核心领域对象,见下)
        ├─ src/tasks.js       计划任务存储 + 30s 调度器
        ├─ src/backups.js     tar.gz 备份/恢复
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
  - stdout/stderr 按行解析:`Done (…s)!` → running;`joined/left the game` → 玩家表
  - stop = stdin 写 `stop`(优雅存档),30s 超时 SIGKILL;exit 事件统一复位状态
  - CPU/RSS 每 2s 从 `/proc/<pid>/stat|status` 采样
- **隧道进程**(独立于服务端,重启实例不断线):ngrok / frpc / playit / bore /
  Pinggy / Serveo 六种驱动,统一输出解析(`\r`/`\n` 双分隔 + ANSI 清洗),
  公网地址就绪后 4s 自动做一次 mcPing 连通性验证,失败原因写入 `tunnelError`

状态经 `snapshot()` 序列化,通过 SSE `state` 事件推送;所有状态变更点都调用
`emitState()`,前端无需轮询。

## 数据与持久化(data/,gitignore)

| 文件 | 内容 | 写入时机 |
|---|---|---|
| users.json | 用户(scrypt 哈希) | 用户增删改 |
| sessions.json | 会话 token(7 天 TTL) | 登录/登出,防抖 500ms |
| instances.json | 实例元数据 + 穿透配置 | 实例/配置变更 |
| tasks.json | 计划任务 | 任务变更、每次触发 |
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
- 登录限速(5 次失败锁 1 分钟);隧道配置输入全部白名单化清洗
- 全局错误中间件 + `asyncHandler`:异步路由抛错返回 500 JSON,不打崩进程

## 进程模型

PM2 **fork 模式**(见 ecosystem.config.js)。面板是有状态进程(会话、SSE 订阅、
子进程句柄),**不能**用 cluster 多副本。SIGTERM/SIGINT 时向所有子服发送
`stop` 落盘,8s 后退出。

## 测试

`npm test`(scripts/smoke.js)对运行中的面板做 26 项真实 API 回归:
健康检查、鉴权边界(401/403/404)、路径沙箱、实例全部子资源读取。
