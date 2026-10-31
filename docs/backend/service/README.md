# Service 服务层总览

> 源码 [apps/backend/src/service/](../../../apps/backend/src/service) ｜ 上级 [README](../../README.md) ｜ 子模块 [./chat.md](chat.md) ｜ [./message.md](message.md) ｜ [./websocket.md](websocket.md) ｜ [./http.md](http.md) ｜ 相关 [db.md](../db/README.md)、[../protocol.md](../../shared/protocol/websocket.md)、[../interaction.md](../../shared/protocol/interactions.md)

## 职责

命令监控（实施中）由 [`commands.ts`](../../../apps/backend/src/service/commands.ts) 装配，核心 [`CommandRuntime`](../../../apps/backend/src/service/commandRuntime.ts) 保存活跃取消句柄，`RunningCommand.finish` 仅由执行方观察实际结束后调用；取消请求不直接完成命令。普通 `execute_command` 经 [`hostCommands.ts`](../../../apps/backend/src/service/hostCommands.ts) 登记父层进程组；原始输出先经 [`SensitiveLogStream`](../../../apps/backend/src/utils/sensitiveLogStream.ts) 遮蔽敏感值，再进入 [`CommandLogStore`](../../../apps/backend/src/service/commandLogs.ts) 和[流式 Drain](../utils/drain.md)。[`CommandMonitor`](../../../apps/backend/src/service/commandMonitor.ts) 注册 `agent.command.*`，逐次按已认证身份核对根会话所有者，先授权再分页或推送；斜杠指令菜单 `command.list` 独立保留。日志订阅随连接释放，慢连接不无限缓存，须重连补读。相关测试位于 [`commandRuntime.test.ts`](../../../apps/backend/test/service/commandRuntime.test.ts)、[`commandLogs.test.ts`](../../../apps/backend/test/service/commandLogs.test.ts) 和 [`commandMonitor.test.ts`](../../../apps/backend/test/service/commandMonitor.test.ts)。受管命令、QQ 双端及界面仍在接入，整项尚未验证可用；共同约定见[命令监控契约](../../shared/protocol/websocket.md#agent-命令监控已批准实施中)。

受管命令控制器的本机 Socket 协议由 [`socketRpc.ts`](../../../apps/backend/src/service/managedApp/socketRpc.ts) 与 [`types.ts`](../../../apps/backend/src/service/managedApp/types.ts) 共同维护：命令执行可在最终响应前返回带请求 ID 的有界 stdout/stderr 原文帧，Backend 将其送入同一命令日志写者，不拿截断工具预览冒充原文。传输失败不中止执行；执行状态须另查原 taskId，取消确认仍不等于最终退出。此接入正在实施，不能推断现有部署已支持流式帧。

主 Agent 执行观察的记录器写者、恢复与失败边界见[执行观察](workflow.md)，跨端字段见[workflow 契约](../../shared/protocol/workflow.md)。

service 层是「外部世界 ↔ agent 内核」的边界。它把 WebSocket 上的 RPC 请求路由到对应 handler，把 agent 的流式 `MiddlewareChunk` 流映射成协议层 Chunk/Notification 推回客户端，并集中处理 DB 持久化与审批副作用。

- **启动装配**（[apps/backend/src/index.ts](../../../apps/backend/src/index.ts)、[worker.ts](../../../apps/backend/src/worker.ts)、[index.ts](../../../apps/backend/src/service/index.ts)）：常规入口由 Manager 启动 Backend guardian/worker；内部创建 Agent Runtime，再由 `startService({port, webPort, staticDir})` 注册 Router、启动 WebSocket/HTTP，并启动同进程 `IngressHost`。配置 `remote` 时再启动两个仅 loopback 的远程入口，并从 `ready` 取得实际端口。配套启动与目录见[运行指南](../../guides/backend-runtime.md)。
- **独立运行边界**：Electron 不参与启动；本地管理器、Docker 或 systemd 只负责 Backend 进程生命周期。Runtime QQPlugin 必须由 `IngressHost` 从受管包目录注入和启动，不存在独立 QQ 后端生命周期。
- **管理器状态摘要**：worker 通过 [`writeBackendStatusFile`](../../../apps/backend/src/service/runtimeStatus.ts) 向 `CHERY_BACKEND_STATUS_FILE` 原子写入运行实例、实际监听、上报周期和非敏感 Agent 运行统计。Manager 结合有效记录与实际端口判断，不把端口可连接或旧记录当作当前运行事实；唯一规则见[运行状态记录约定](../../shared/protocol/manager-auth.md#运行状态记录约定)。写入与状态边界回归见 [`runtimeStatus.test.ts`](../../../apps/backend/test/service/runtimeStatus.test.ts) 和 [Manager 状态测试](../../../apps/manager/test/runtimeStatus.test.ts)。
- **RPC 路由**（[message/](../../../apps/backend/src/service/message)）：Request/Response/Chunk/Notification 四象限类型 + `RpcRouter` 分发。详见 [./message.md](message.md)。
- **接入插件**（[ingress/](../../../apps/backend/src/service/ingress)）：`IngressHost` 装载显式安装启用的ESM包，保存独立配置和请求快照；`startService().ready` 等待启动，worker关闭先 `stopIngress()`。包/API/维护命令与验证唯一说明见[接入插件契约](../../shared/architecture/ingress-plugins.md)，不与技能包混用。
- **传输实现**（[websocket/](../../../apps/backend/src/service/websocket)）：ws 封装、连接状态、二进制帧编解码。详见 [./websocket.md](websocket.md)。
- **chat 枢纽**（[chat/](../../../apps/backend/src/service/chat)）：流式执行、observer 副作用、streamMapper 映射、runtime 缓存、chat 管理。详见 [./chat.md](chat.md)。
- **单文件 handler**：`approval/`、`bash/`、`brain/`、`runtime/`、`sense/` 各负责少量 RPC 方法。

## 启动流程

入口 [apps/backend/src/index.ts](../../../apps/backend/src/index.ts) `main()`：

```
initLogger(config.global.logger)
WS_PORT    = config.server.port
WEB_PORT   = config.server.webPort   // 优先级 WEB_PORT 环境变量 > server.webPort > 默认 8183
STATIC_DIR = process.env.WEB_DIST_DIR ?? ../web/dist
bootstrapAgentRuntime()          // 注册内置 Provider + 重建 Sense registry
{ wss, httpServer } = startService({ port: WS_PORT, webPort: WEB_PORT, staticDir: STATIC_DIR })  // ← 本模块入口
getSoulDb()                      // 初始化数据库
SIGINT/SIGTERM → wss.close() + httpServer.close() + closeAllDbs() + exit
```

**守护进程（guardian）双进程模型**：`node dist/index.js`（无参数）→ 守护进程 [apps/backend/src/index.ts](../../../apps/backend/src/index.ts) spawn worker（`--worker` 标志，同文件重入）。worker 崩退 → guardian 指数退避重启（500ms 起，封顶 10s）。**端口占用不重试**：worker 监听失败（EADDRINUSE）时经 IPC `process.send({type:"fatal", code, port})` 上报（见 [fatalStartup.ts](../../../apps/backend/src/service/fatalStartup.ts)），guardian 收到后打印「端口 N 已被占用」并退出（不进入重启循环）——因为端口被占用属环境问题，重试无效。维护子命令（`compile-senses`/`reconcile-db` 等）不进入守护循环，直接 runWorker。**Windows spawn 约定**：guardian spawn worker 是控制台子进程，须 `windowsHide: true`（CREATE_NO_WINDOW）隐藏，避免无控制台的父进程 spawn 时闪现 cmd 窗。

guardian 在启动常驻 worker 或执行维护子命令前，会把不可变 `.chery.template/` 安全同步到 `CHERY_DIR/.chery/`：全新 workspace 初始化完整副本；已有 workspace 只更新仍保持官方哈希的文件，并保留用户修改/主动删除。替换前备份到 `.chery/backups/template/<timestamp>/`，`config.yaml` 只迁移缺失的内置资源。模板默认取后端 bundle 同级的 `.chery.template/`，可用 `CHERY_TEMPLATE_DIR` 覆盖；同步失败只告警，不阻止原 workspace 启动。

`startService`（[service/index.ts](../../../apps/backend/src/service/index.ts)）：

```ts
export function startService(options: { port: number; webPort: number; staticDir: string }): ServiceHandle {
  const router = createRouter();
  registerBrainHandlers(router);        // brain.list
  registerSenseHandlers(router);        // sense.list / sense.tools
  registerSkillHandlers(router);        // skills.list
  registerSkillImportHandlers(router);  // skills.importUrl / skills.commit / skills.delete
  registerPluginHandlers(router);       // plugins.list / plugins.preImportUrl / plugins.importUrl / plugins.commit / plugins.checkUpdate / plugins.update / plugins.uninstall
  registerCredentialsHandlers(router);  // credentials.list / credentials.save / credentials.delete
  registerRuntimeSetHandlers(router);   // runtime.set
  registerChatHandlers(router);         // chat.run.resume / chat.abort（chat.send / chat.resume 亦被 chat.input.submit / chat.resumeTree / spawn 链内部复用）
  registerChatManageHandlers(router);   // chat.create / chat.list / chat.get / chat.delete
  registerBashHandlers(router);         // bash.list / bash.kill
  registerMcpHandlers(router);          // mcp.list / mcp.get / mcp.connect / mcp.disconnect / mcp.reload
  const wss = createWebSocketServer({ port: options.port, router });
  const httpServer = createHttpServer({ webPort: options.webPort, staticDir: options.staticDir, webSocketServer: wss });
  return { wss, httpServer };
}
```

> service/index.ts 另 `export { createWebSocketServer }`、`export { createHttpServer }`、`export { createRouter }`、`export * from message/types`，供测试与外部组装复用。HTTP 服务（`/api/config` + 静态 serve）详见 [./http.md](http.md)。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [apps/backend/src/service/index.ts](../../../apps/backend/src/service/index.ts) | `startService({port, webPort, staticDir})`：建 Router + 注册全部 handler + 建 WebSocketServer + HTTP 服务器 |
| [apps/backend/src/service/http/index.ts](../../../apps/backend/src/service/http/index.ts) | `createHttpServer`：HTTP `/api/config` + 静态 serve → [./http.md](http.md) |
| [apps/backend/src/service/message/index.ts](../../../apps/backend/src/service/message/index.ts) | barrel：types + router |
| [apps/backend/src/service/message/types.ts](../../../apps/backend/src/service/message/types.ts) | RPC 全部类型、`Method`/`ErrorCode` 常量、工厂、类型守卫 |
| [apps/backend/src/service/message/router.ts](../../../apps/backend/src/service/message/router.ts) | `RpcRouter`：注册、分发、流式包装、错误转换 |
| [apps/backend/src/service/websocket/index.ts](../../../apps/backend/src/service/websocket/index.ts) | `createWebSocketServer`：ws 服务、消息分发、流式推送、审批超时 |
| [apps/backend/src/service/websocket/connection.ts](../../../apps/backend/src/service/websocket/connection.ts) | `ConnectionManager` 单例：连接状态、chat 绑定、pendingRequest approvalId 映射、close park |
| [apps/backend/src/service/websocket/transport.ts](../../../apps/backend/src/service/websocket/transport.ts) | `Transport` 单例：二进制/JSON 帧编解码 |
| [apps/backend/src/service/chat/send.ts](../../../apps/backend/src/service/chat/send.ts) | `handleChatSend`/`handleChatResume`/`handleChatAbort`（chat.send / chat.resume 为内部命令，由 chat.input.submit / chat.resumeTree / spawn 链复用） |
| [apps/backend/src/service/chat/handler.ts](../../../apps/backend/src/service/chat/handler.ts) | `handleChatCreate`/`handleChatList`/`handleChatGet`/`handleChatDelete` |
| [apps/backend/src/service/chat/observer.ts](../../../apps/backend/src/service/chat/observer.ts) | `observeAgentChunks`：effect chunk → DB/审批副作用 |
| [apps/backend/src/service/chat/streamMapper.ts](../../../apps/backend/src/service/chat/streamMapper.ts) | `streamAgentChunks`：MiddlewareChunk → 协议 Chunk/Notification |
| [apps/backend/src/service/chat/runtime.ts](../../../apps/backend/src/service/chat/runtime.ts) | `chatRuntimes` Map + `ensureChat`/`setRuntime`/`clear`/`abort`/`getAgentRuntimeStats` |
| [apps/backend/src/service/approval/manager.ts](../../../apps/backend/src/service/approval/manager.ts) | `ApprovalManager` 单例：极简审批（Set + 转调 core registry） |
| [apps/backend/src/service/bash/handler.ts](../../../apps/backend/src/service/bash/handler.ts) | `bash.list` / `bash.kill` handler |
| [apps/backend/src/service/brain/list.ts](../../../apps/backend/src/service/brain/list.ts) | `brain.list` handler |
| [apps/backend/src/service/runtime/set.ts](../../../apps/backend/src/service/runtime/set.ts) | `runtime.set` handler |
| [apps/backend/src/service/sense/list.ts](../../../apps/backend/src/service/sense/list.ts) | `sense.list` handler |
| [apps/backend/src/service/skill/list.ts](../../../apps/backend/src/service/skill/list.ts) | `skills.list` handler（独立 + 插件 skill 元数据） |
| [apps/backend/src/service/skill/import.ts](../../../apps/backend/src/service/skill/import.ts) | `skills.importUrl` / `skills.commit` / `skills.delete` handler（两阶段 stage→commit） |
| [apps/backend/src/service/plugin/list.ts](../../../apps/backend/src/service/plugin/list.ts) | `plugins.list` handler + `buildPluginInfo`/`listPluginSkills`（manifest + skills 扫描，loader 共用） |
| [apps/backend/src/service/plugin/import.ts](../../../apps/backend/src/service/plugin/import.ts) | `plugins.preImportUrl` / `plugins.importUrl` / `plugins.commit` / `plugins.checkUpdate` / `plugins.update` / `plugins.uninstall` handler |
| [apps/backend/src/service/plugin/index.ts](../../../apps/backend/src/service/plugin/index.ts) | barrel：`registerPluginHandlers`（7 方法，见 [启动流程](#启动流程)） |
| [apps/backend/src/service/credentials/handler.ts](../../../apps/backend/src/service/credentials/handler.ts) | `credentials.list` / `credentials.save` / `credentials.delete` handler + `registerCredentialsHandlers`（包 [secretStore](../../../apps/backend/src/utils/secretStore.ts)） |
| [apps/backend/src/service/browse/sandbox.ts](../../../apps/backend/src/service/browse/sandbox.ts) | `config.workspace.browse` 沙箱：默认全盘浏览（POSIX `/` / win32 盘符）+ 可选 roots 收窄、`.chery` 拦截、软链逃逸阻断、跨平台 |
| [apps/backend/src/service/browse/session.ts](../../../apps/backend/src/service/browse/session.ts) | `BrowseSessionStore` 单例：浏览会话 TTL + 每会话限流 + 并发上限 + sweep 清理 |
| [apps/backend/src/service/browse/handler.ts](../../../apps/backend/src/service/browse/handler.ts) | `config.workspace.browse.start` / `.list` handler + `registerBrowseHandlers`（解密路径 → 沙箱 → 加密回传） |
| [apps/backend/src/service/workspace/](../../../apps/backend/src/service/workspace) | 当前 chat 工作区的文件列表、只读读取和文件引用校验（实施中） |
| [apps/backend/src/service/terminal/](../../../apps/backend/src/service/terminal) | 本机与 SSH Terminal session、输入输出和生命周期（实施中） |

## RPC 模式

四种消息：`Request`（C→S）、`Response`（S→C 请求返回）、`Chunk`（S→C 流式增量，stream 走二进制帧）、`Notification`（S→C 推送）。完整字段、传输帧格式、错误码见 [../protocol.md](../../shared/protocol/websocket.md)；类型与路由机制见 [./message.md](message.md)。

Router 分发要点：handler 返回普通 `Promise` → 直接 Response；返回 `AsyncGenerator` → `wrapStreamingHandler` 迭代 yield Chunk/Notification、最终 return ResponseData 包装成 Response（详见 [./message.md](message.md)「关键流程」）。

### 配置生效通知与客户端兼容

`config.save` 的 Response 只确认候选已保存，并返回逐资源 `ConfigApplyState`；服务端还向每个已连接客户端广播 `config.apply.changed`，使其他设置窗口刷新状态而不覆盖本地未保存草稿。客户端必须识别协议版本 2 的 `savedRevision`、`appliedRevision`、`impacts` 和 `restart`。无法解析该状态的旧客户端应提示升级或刷新，不能把未知结果显示为“已生效”。

设置保存不会关闭 WebSocket。仅 worker 实际重启后，客户端才按既有重连流程获取新的连接配置；重连期间应重新查询 `config.apply.status`。后台命令、MCP 调用和正在运行的 Agent 是重启 blocker，服务不会自动终止它们或承诺在重启后透明恢复。

## Handler 总览

| RPC 方法 | Handler | 文件 | 流式 | 一句话 |
|----------|---------|------|------|--------|
| `brain.list` | `handleBrainList` | [brain/list.ts](../../../apps/backend/src/service/brain/list.ts) | 否 | 列 config.yaml 的 brain + 全局 senseGroups + 已连接 mcpServers |
| `sense.list` | `handleSenseList` | [sense/list.ts](../../../apps/backend/src/service/sense/list.ts) | 否 | 列 config.yaml 的 sense_groups（原始字符串，含 `:level` 后缀） |
| `sense.tools` | `handleSenseTools` | [sense/list.ts](../../../apps/backend/src/service/sense/list.ts) | 否 | 列代码维护的全部内置工具（name/label/description/icon）供设置面板下拉 |
| `sense.tools.docs` | `handleSenseToolDocs` | [sense/list.ts](../../../apps/backend/src/service/sense/list.ts) | 否 | 统一返回内置工具完整说明（全量或按 name 列表过滤），供设置面板 hover 展示 |
| `skills.list` | `handleSkillsList` | [skill/list.ts](../../../apps/backend/src/service/skill/list.ts) | 否 | 实时列 `.chery/skills/`（独立）+ `.chery/plugins/*/`（插件）skill 元数据（含 contextTokens） |
| `skills.importUrl` | `handleSkillsImportUrl` | [skill/import.ts](../../../apps/backend/src/service/skill/import.ts) | 否 | 拉 GitHub 独立技能集合到 staging，返 `{stagingId, candidates}`（两阶段） |
| `skills.commit` | `handleSkillsCommit` | 同上 | 否 | 按 `{stagingId, selections}` 落盘 stage 候选为独立 skill |
| `skills.delete` | `handleSkillsDelete` | 同上 | 否 | 删除独立 skill 目录（`skills_dir/<name>`） |
| `plugins.list` | `handlePluginsList` | [plugin/list.ts](../../../apps/backend/src/service/plugin/list.ts) | 否 | 列已安装插件（manifest + skills 扫描，透出 cloneUrl/branch/commitSha/commitDate） |
| `plugins.preImportUrl` | `handlePluginsPreImportUrl` | [plugin/import.ts](../../../apps/backend/src/service/plugin/import.ts) | 否 | 拉远端分支列表 + 探测 needsAuth（git CLI 硬性前提预检） |
| `plugins.importUrl` | `handlePluginsImportUrl` | 同上 | 否 | git clone 整仓到 staging（支持 branch 选择 + 鉴权注入） |
| `plugins.commit` | `handlePluginsCommit` | 同上 | 否 | 落盘 staged 插件 + 写 `.chery-plugin.json` manifest（cloneUrl/branch/commitSha/commitDate） |
| `plugins.checkUpdate` | `handlePluginsCheckUpdate` | 同上 | 否 | 比对 currentSha/latestSha + 取 latestDate（GitHub REST，私有仓降级） |
| `plugins.update` | `handlePluginsUpdate` | 同上 | 否 | 按 `manifest.cloneUrl+branch` 重新 git clone 覆盖 |
| `plugins.uninstall` | `handlePluginsUninstall` | 同上 | 否 | 删除整个插件目录 |
| `credentials.list` | `handleCredentialsList` | [credentials/handler.ts](../../../apps/backend/src/service/credentials/handler.ts) | 否 | 列凭据池（仅 id/label/username，密令不外露） |
| `credentials.save` | `handleCredentialsSave` | 同上 | 否 | AES-256-GCM 加密保存（password/token 字段自动脱敏） |
| `credentials.delete` | `handleCredentialsDelete` | 同上 | 否 | 按 id 删凭据（幂等） |
| `runtime.set` | `handleRuntimeSet` | [runtime/set.ts](../../../apps/backend/src/service/runtime/set.ts) | 否 | 原子设置 chat 的 brain + senseGroup + mcpServers |
| `chat.create` | `handleChatCreate` | [chat/handler.ts](../../../apps/backend/src/service/chat/handler.ts) | 否 | 建 chat + ensureChat 注入 runtime + 加载历史 |
| `chat.list` | `handleChatList` | 同上 | 否 | 全局列表（读冗余 message_count） |
| `chat.get` | `handleChatGet` | 同上 | 是 | 流式载入历史 + loaded + canResume |
| `chat.delete` | `handleChatDelete` | 同上 | 否 | clearChatRuntime + deleteChat |
| `chat.send` | `handleChatSend` | [chat/send.ts](../../../apps/backend/src/service/chat/send.ts) | 是 | 流式发送；恢复撤回；运行中仅入队 |
| `chat.resume` | `handleChatResume` | 同上 | 是 | 续接（无 prompt），恢复执行 / 继续 loop |
| `chat.abort` | `handleChatAbort` | 同上 | 否 | abort generator + 强制解绑 + 清内存 |
| `bash.list` | `handleBashList` | [bash/handler.ts](../../../apps/backend/src/service/bash/handler.ts) | 否 | 列 chat 挂起的 bash 进程 |
| `bash.kill` | `handleBashKill` | 同上 | 否 | 杀死挂起 bash 进程组 |
| `mcp.list` | `handleMcpList` | [mcp/handler.ts](../../../apps/backend/src/service/mcp/handler.ts) | 否 | 列 config 声明的 MCP server 及状态 |
| `mcp.get` | `handleMcpGet` | 同上 | 否 | 查看单个 MCP server |
| `mcp.connect` | `handleMcpConnect` | 同上 | 否 | 连接并注册单个 MCP server 的 senses |
| `mcp.disconnect` | `handleMcpDisconnect` | 同上 | 否 | 断开并反注册单个 MCP server |
| `mcp.reload` | `handleMcpReload` | 同上 | 否 | 重载单个或全部 MCP server |
| `subagent.result` | `handleSubagentResult` | [subagent/index.ts](../../../apps/backend/src/service/subagent/index.ts) | 否 | 子 agent 结果回传（唤醒主 agent 挂起的 spawn） |
| `config.get` | `handleConfigGet` | [config/handler.ts](../../../apps/backend/src/service/config/handler.ts) | 否 | 读 .chery/config.yaml 原文（除 server 段） |
| `config.save` | `handleConfigSave` | 同上 | 否 | 校验 + 写回 config.yaml（除 server），返回统一生效状态与影响项 |
| `utils.models` | `handleUtilsModels` | [utils/handler.ts](../../../apps/backend/src/service/utils/handler.ts) | 否 | 基于 provider/url/key/fullUrl 拉取可用模型列表（fullUrl=true 不补全 URL，与正式 chat 同规则）。anthropic 为双尝试：主尝试原生 `/models?limit=1000`，失败且未勾选 fullUrl 时回退 OpenAI 兼容 `GET /models`（Bearer），两边均无产出则 error 聚合两段原因（见 [provider.md「anthropic 模型列表双尝试」](../agent/provider.md)） |
| `utils.testConnection` | `handleUtilsTestConnection` | [utils/handler.ts](../../../apps/backend/src/service/utils/handler.ts) | 否 | 用未保存配置执行真实最小 Provider 请求（透传 fullUrl），不持久化、不重试 |
| `env.list` | `handleEnvList` | [utils/handler.ts](../../../apps/backend/src/service/utils/handler.ts) | 否 | 实时列出 .env 变量名；新增、轮换或删除会重新解析引用资源并返回 apply 状态，`CHERY_DIR`、`DB_DIR`、`WEB_PORT` 和认证初始化变量保持启动绑定并登记重启待办 |
| `utils.openFile` | `handleUtilsOpenFile` | [utils/handler.ts](../../../apps/backend/src/service/utils/handler.ts) | 否 | 打开指定文件（用配置编辑器或系统默认）；win32 以 `detached:true` 新进程组拉起编辑器，**不带 `windowsHide`**（GUI 编辑器如 notepad 需显示窗口；spawn 失败仅记 error 日志，不弹窗） |
| `utils.openConfigDir` | `handleUtilsOpenConfigDir` | [utils/handler.ts](../../../apps/backend/src/service/utils/handler.ts) | 否 | 固定打开后端主机的 `CHERY_DIR/.chery` 配置目录 |
| `utils.editors` | `handleUtilsEditors` | [utils/handler.ts](../../../apps/backend/src/service/utils/handler.ts) | 否 | 检测后端主机可用的文本编辑器 |
| `config.workspace.browse.start` | `handleBrowseStart` | [browse/handler.ts](../../../apps/backend/src/service/browse/handler.ts) | 否 | 开启浏览会话（根锚定 + 一次性 sessionId + 限流） |
| `config.workspace.browse.list` | `handleBrowseList` | 同上 | 否 | 解密路径 → 沙箱列目录 → 同 nonce 加密回传（权限拒绝结构化返回不抛错） |
| `workspace.files.list` | `handleWorkspaceFilesList` | [workspace/handler.ts](../../../apps/backend/src/service/workspace/handler.ts) | 否 | 当前 chat 工作区内懒加载列目录 |
| `workspace.files.read` | `handleWorkspaceFilesRead` | 同上 | 否 | 当前 chat 工作区内有界只读读取 |
| `terminal.create/input/resize/close` | `TerminalManager` | [terminal/manager.ts](../../../apps/backend/src/service/terminal/manager.ts) | 否 | 本机或 SSH 交互会话；事件经 WebSocket notification 推送 |

`Method` 常量全集见 [./message.md](message.md)「Method 常量」。chat.* 流程细节见 [./chat.md](chat.md)。

## 核心概念 / 导出

- **`startService({port, webPort, staticDir})`**（index.ts）：Backend 内部的服务装配入口，返回 `{wss, httpServer, ingress, ready}`；正式常驻进程仍从 `apps/backend/src/index.ts` 的 guardian/worker 进入。`webPort` 来自环境变量 `WEB_PORT`（默认 8183，原 `config.server.web_port` 已废弃）；HTTP 由 `createHttpServer` 提供（见 [./http.md](http.md)）。
- **`RpcRouter`**（message/router.ts）：`register` / `handle`，handler 联合 `HandlerContext`（含 requestId、connectionId）。
- **`connectionManager`**（websocket/connection.ts 单例）：chat 活跃绑定、pendingRequest approvalId 映射、close park。
- **`transport`**（websocket/transport.ts 单例）：帧编解码。
- **`approvalManager`**（approval/manager.ts 单例）：极简审批。
- **`chatRuntimes`**（chat/runtime.ts 模块级私有 Map）+ `ensureChat`/`setRuntime` 等导出。

## 关键流程 / 数据流

核心数据流（WebSocket 收 Request → 推送）：

```
ws.on("message")
  → transport.parseMessage → isRequest?
  → router.handle(request, ctx)
     → handler(ctx, params)
        → [chat.send/resume] AgentBuilder.run/resume → AsyncGenerator<MiddlewareChunk>
           → observeAgentChunks(gen, chatId, getMessages)   // 拦截 effect 做 DB/审批副作用
           → streamAgentChunks(gen, rid)                    // MiddlewareChunk → Chunk/Notification
     → wrapStreamingHandler 迭代 yield
  → handleRequest 逐帧：
       notification(interrupt) → setRequestApprovalId（记 approvalId→requestId 供 close park；限时超时由 core approvalRegistry 管，0=不限时）
       ws.send(transport.encode(item))                      // Chunk/Notification 编码
     最终 Response → ws.send(transport.serializeMessage)
  → removePendingRequest
```

各子环节展开见对应子文档：[./message.md](message.md)（路由）、[./websocket.md](websocket.md)（传输/连接）、[./chat.md](chat.md)（chat 流式/observer/审批）。

## 单文件 Handler 章节

### approval/manager —— 极简审批管理器

| 项 | 内容 |
|----|------|
| 源码 | [approval/manager.ts](../../../apps/backend/src/service/approval/manager.ts) |
| 对应 RPC | 无直接 RPC；被 observer（`register`）与 `interaction.approval.decide`（`confirm`）、ws close（`abort`）调用 |
| 职责 | 极简审批：仅维护 `Set<approvalId>`，`confirm`/`abort` 转调 core [approvalRegistry](../../../apps/backend/src/core/sense/approvalRegistry.ts) 解除 senseMiddleware 的 await Promise |

```ts
class ApprovalManager {
  private approvals = new Set<string>();
  register(approvalId): void;                                  // observer 收 sense_pending 时调
  confirm(approvalId, action:"accept"|"reject", reason?): void; // → resolveApproval(id, action, reason)
  abort(approvalId): void;                                      // → rejectApproval(id, Error("approval aborted"))
}
export const approvalManager: ApprovalManager;
```

> ⚠ **P1-11 解耦后**：`ApprovalManager` 不再存 resolve/reject 函数指针，只登记 id，触发由 core registry 负责。`.claude/CLAUDE.md` 仍写「存 approvalResolve 回调」——与代码不符。无 DB 持久化（pending sense 靠 messages.content 空判定，见 [db.md](../db/README.md)）。完整 service 侧审批流程见 [./chat.md](chat.md)「审批 service 侧流程」。

### bash/handler —— 挂起 bash 进程管理

| 项 | 内容 |
|----|------|
| 源码 | [bash/handler.ts](../../../apps/backend/src/service/bash/handler.ts) |
| 对应 RPC | `bash.list`（`handleBashList`）、`bash.kill`（`handleBashKill`） |
| 职责 | 列出 / 杀死某 chat 挂起的 bash 子进程（进程组）。注册表由 agent 层持有 |

```ts
handleBashKill(ctx, {chatId, pid}): Promise<{chatId, pid, killed: boolean}>   // killBashProcess(chatId, pid)
handleBashList(ctx, {chatId}): Promise<{chatId, processes: BashProcessInfo[]}> // listBashProcesses(chatId)
registerBashHandlers(router): void;  // 注册 Method.BASH_KILL / BASH_LIST
```

`BashProcessInfo`（[message/types.ts](../../../apps/backend/src/service/message/types.ts)）对齐 agent/sense/processRegistry 的 `BashProcessEntry`（service 层不反向依赖 agent，独立定义）。范式同 `ApprovalManager` 调 core registry——注册表在 agent/core 层，service 层只触发。`killed=false` 表示 pid 已不在挂起表中。

### brain/list —— 列出 brain

| 项 | 内容 |
|----|------|
| 源码 | [brain/list.ts](../../../apps/backend/src/service/brain/list.ts) |
| 对应 RPC | `brain.list`（`handleBrainList`） |
| 职责 | 枚举 `config.llm.brain` 全部 brain（name/provider/model/thinking/capabilities）+ 全局全量 senseGroups |

```ts
handleBrainList(ctx, params): Promise<{brains: Array<{name, provider, model, thinking?, capabilities?, senseGroups: string[]}>}>;
registerBrainHandlers(router): void;
```

`senseGroups` 返回 `Object.keys(config.sense_groups ?? {})`，全局全量、每个 brain 相同（交互示例见 [../interaction.md](../../shared/protocol/interactions.md) brain.list）。

### runtime/set —— 原子设置 runtime

| 项 | 内容 |
|----|------|
| 源码 | [runtime/set.ts](../../../apps/backend/src/service/runtime/set.ts) |
| 对应 RPC | `runtime.set`（`handleRuntimeSet`） |
| 职责 | 原子校验 + 设置 chat 的 brain + senseGroup（每轮可换） |

```ts
handleRuntimeSet(ctx, {chatId, brain, senseGroup}): Promise<{chatId, brain, senseGroup}>;
```

流程：`getChat` 存在性校验 → `parseRuntimeSelection(p, "runtime.set")`（[agent/runtimeResolver](../../../apps/backend/src/agent/runtimeResolver.ts)）→ `setRuntime(chatId, selection)`（[chat/runtime.ts](../../../apps/backend/src/service/chat/runtime.ts)，原子注入 builder + 持久化 metadata.runtime）。前置：chat 必须已存在（`chat.create`）。

`parseRuntimeSelection` 以 brain 的 `capabilities.toolCall` 为准：无 Tool Call brain 只允许空 senseGroup/MCP；支持 Tool Call 的 brain 仍必须有 senseGroup。该规则同样作用于 `chat.create` 与 `session.runtime.set`，防止客户端仅靠 UI 绕过限制。

### sense/list —— 列出 sense groups

| 项 | 内容 |
|----|------|
| 源码 | [sense/list.ts](../../../apps/backend/src/service/sense/list.ts) |
| 对应 RPC | `sense.list`（`handleSenseList`） |
| 职责 | 枚举 `config.sense_groups`（name + senses 原始字符串数组） |

```ts
handleSenseList(ctx, params): Promise<{senseGroups: Array<{name, senses: string[]}>}>;
registerSenseHandlers(router): void;
```

`senses` 为 config 原始字符串，含 `:level` 后缀（如 `execute_command:auto`），**未解析**（解析发生在 agent RuntimeResolver.resolveSense，见 [../../src/agent/runtimeResolver.ts](../../../apps/backend/src/agent/runtimeResolver.ts)）。

## 依赖与关联 ⭐

**被依赖：**

- [apps/backend/src/index.ts](../../../apps/backend/src/index.ts)：`startService({port, webPort, staticDir})`、（间接）`getSoulDb`/`closeAllDbs`。

**依赖（跨模块）：**

- [@/agent/builder](../../../apps/backend/src/agent/builder.ts)、[@/agent/runtimeResolver](../../../apps/backend/src/agent/runtimeResolver.ts)：chat/ + runtime/ handler。
- [@/agent/sense/processRegistry](../../../apps/backend/src/agent/sense/processRegistry.ts)：`killBashProcess` / `listBashProcesses`（bash/handler）。
- [@/core/sense/approvalRegistry](../../../apps/backend/src/core/sense/approvalRegistry.ts)：`resolveApproval` / `rejectApproval`（approval/manager）。
- [@/db/chat](../../../apps/backend/src/db/chat.ts)、[@/db/index](../../../apps/backend/src/db/index.ts)：chat/ handler、chat/observer、runtime/、brain/ 等（详见 [db.md](../db/README.md)）。
- [@/utils/config](../../../apps/backend/src/utils/config.ts)：brain/list、sense/list 读 config；index.ts 读 `config.server.port`。
- [@/utils/logger](../../../apps/backend/src/utils/logger/index.ts)、[@/utils/generator](../../../apps/backend/src/utils/generator.ts)、[@/utils/json](../../../apps/backend/src/utils/json.ts)。
- `ws`、`better-sqlite3`（间接，经 db 模块）。

**横切参考：**

- [../protocol.md](../../shared/protocol/websocket.md)：协议规范（消息结构、方法、错误码、HTTP 端点）。
- [../interaction.md](../../shared/protocol/interactions.md)：各方法端到端交互序列。
- [../mock.md](../../quality/testing/mock-provider.md)：前端/mock 与本服务交互。
- [db.md](../db/README.md)：DB schema、状态判定、路由。

## 扩展点

- **新增 RPC 方法**：types.ts 加 Method + Request/Response Data；写 handler（`Promise` 或 `AsyncGenerator`）+ `register*Handlers`；service/index.ts `startService` 调注册；同步补 [../protocol.md](../../shared/protocol/websocket.md)。
- **新增单文件 handler 模块**：仿 brain/list.ts（读 config）或 bash/handler.ts（调 agent 注册表）模式，新建 `service/<name>/handler.ts`。
- **更换传输/服务实现**：`createWebSocketServer` 是唯一 ws 入口；`transport`/`connectionManager` 为单例，替换时需保持 chat 绑定与审批超时语义。
