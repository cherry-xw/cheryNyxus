# cheryClaw 文档索引

> cheryClaw 是多 LLM Agent 框架（**Brain**=AI 服务 / **Sense**=受监管的感官工具 / **Chat**=消息通道，三者解耦）。本目录是项目的 **AI 知识地图**——按源码模块组织实现细节，目标是：针对某个开发目标，读最少上下文即可定位并理解所需模块。

## 怎么用这套文档（给 AI / 开发者）

## 开发准则：文档先行

凡是新增、调整或删除功能模块，**在下达代码修改任务之前**，必须先更新对应模块文档：说明职责、公开配置或接口、关键数据流、依赖关系与用户可见行为。文档与实现不一致时，先修正文档并确认边界，再开始代码修改；仅格式化、纯重命名等不改变功能语义的改动可例外。

1. **定位模块**：按下面「按模块」找到目标模块文档。
2. **读模块文档**：每篇自包含——职责 / 文件清单 / 核心导出 / 关键流程 / 依赖与关联 / 扩展点。
3. **按「依赖与关联」扩展**：每篇末尾的「依赖与关联」列出**真实**的依赖与被依赖关系。只顺藤读真正相关的文档，不要全读。
4. **跨模块的协议 / 交互 / 数据流**：查「按主题」横切文档。

## 按模块（镜像 `src/`）

### [core/](./core/README.md) — 框架抽象层
> 类型、Adapter 注册表（LLM/Message/Sense）、AgentSession / MiddlewarePipeline、Sense 工厂。不含具体实现，被 agent/ 大量依赖。

- [core/README.md](./core/README.md) — 总览
- [llm.md](./core/llm.md) — `LLMAdapter`（chat/chatStream）+ 注册表
- [message.md](./core/message.md) — `MessageAdapter`、统一响应、`SenseCallInfo`
- [middleware.md](./core/middleware.md) — `compose()` 洋葱组合器、`AgentSession` / `MiddlewarePipeline` / `MessageJournal`、Context/Chunk 类型
- [sense.md](./core/sense.md) — `sense()` 工厂、感官/审批注册表、**监管等级 auto/confirm/manual**
- [compiler.md](./core/compiler.md) — 外部感官编译器（`.chery/senses/*.ts`）
- [mcp.md](./core/mcp.md) — MCP server 接入：tools/resources/prompts → Sense

### [agent/](./agent/README.md) — 具体实现层
> bootstrap（启动注册）/ builder（装配）/ runtimeResolver（原子解析）+ 中间件链 + 内置感官 + Provider。

- [agent/README.md](./agent/README.md) — 总览
- [middleware.md](./agent/middleware.md) — checkpoint / sense / retry / chat / loop 五中间件 + 审批（**核心文档**）
- [prompt.md](./agent/prompt.md) — system prompt 构建 + skill / plugin 加载
- [provider.md](./agent/provider.md) — openai / ollama / mock 三 Adapter
- [sense.md](./agent/sense.md) — 内置感官 bash / read / write / skill

### [service/](./service/README.md) — 服务层
> WebSocket 服务 + RPC 路由 + chat 流式 + observer 副作用 + 各 RPC handler。

- [service/README.md](./service/README.md) — 总览（含 approval/bash/brain/runtime/sense 5 个单文件 handler）
- [chat.md](./service/chat.md) — chat.send/resume 流式、observer、streamMapper、审批 service 侧
- [message.md](./service/message.md) — RpcRouter 方法路由 + RPC 类型
- [websocket.md](./service/websocket.md) — 连接管理 + 二进制帧编解码
- [http.md](./service/http.md) — HTTP `/api/config` + 静态 serve（前端自动构建 WS 地址）

### [db.md](./db.md) — 持久化
> 多 sqlite 实例（soul.db.chats + 按月分片 YYYY-MM.db.messages）、CRUD、表结构、状态判定（pending/revoked）。

### [memory/](./memory/README.md) — 项目记忆
> Markdown 文件存储的跨会话记忆系统：15 条上限淘汰归档、memory_manage sense 硬编码注入主 agent、system prompt `<memory>` 段。

- [memory/README.md](./memory/README.md) — 存储结构、记忆格式、配置、管理器 API、关键流程

### [utils/](./utils/README.md) — 工具层
> config 加载 / drain 模板挖掘 / logger / hash / json / generator / rateLimiter。被各层依赖，不反向依赖业务。

- [utils/README.md](./utils/README.md) — 总览
- [drain.md](./utils/drain.md) — Drain 日志模板挖掘算法
- [logger.md](./utils/logger.md) — 统一日志（文件 / bash）

### [web/](./web/README.md) — 前端工作区
> pnpm workspace + Turborepo monorepo 的一个 package（Vue3 + Vite 8 + Electron 43），与后端同仓不同包。通过 `/api/config` + WebSocket 消费 [protocol.md](./protocol.md) RPC。

- [web/README.md](./web/README.md) — 总览：技术栈、双运行模式（浏览器/Electron）、构建产物、monorepo 定位、依赖关联
- [web/electron.md](./web/electron.md) — Electron 集成详解：主进程路径解析坑、xrdp 运行环境、sandbox SUID
- [web/deployment.md](./web/deployment.md) — 前后端连接与部署模式：后端独立 / Electron 一体 / Web 浏览器三模式 + 实现路线 + 关键坑

## 按主题（横切参考）

| 文档 | 内容 |
|------|------|
| [protocol.md](./protocol.md) | WebSocket 协议规范：传输帧格式、消息结构、方法列表、HTTP API、错误码 |
| [interaction.md](./interaction.md) | 各 RPC 方法完整交互序列、端到端流程、错误路径 |
| [agent-pet.md](./agent-pet.md) | 主从 Agent 桌宠系统：pet↔chat 绑定、spawn_role 前端驱动架构、CP0-CP7 分阶段 |
| [model-capabilities.md](./model-capabilities.md) | Brain 的 Tool Call/多模态能力、角色与运行时约束、媒体资产和媒体网关 |
| [mock.md](./mock.md) | Mock Provider 脚本化离线测试（send/resume/revoke/loop） |
| [error-conventions.md](./error-conventions.md) | 错误信息分层规范：用户面（直白中文 + tracingId） vs 日志面（结构化 JSON），所有错误出口的硬约束 |

## 项目入口与配置

| 资源 | 内容 |
|------|------|
| [根 README](../README.md) | 项目综述、隐喻体系、启动指令、配置文件清单 |
| [.chery/config.yaml](../.chery/config.yaml) | LLM 客户端 + Sense 分组 + 全局配置 + 服务端口 |
| [.claude/CLAUDE.md](../.claude/CLAUDE.md) | AI 协作规范（极简索引） |
