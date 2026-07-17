# cheryClaw 项目规范

> 本文件是 AI 协作的**极简索引**。实现细节已下沉到 [docs/](../docs/) 各模块文档——针对开发目标时，从 [docs/README.md](../docs/README.md) 定位模块，读对应文档的「依赖与关联」即可确定最小上下文。

## 项目概述

多 LLM Agent 框架，支持 Ollama、OpenAI、Mock 等提供商。三大解耦隐喻：**Brain**（AI 服务，每轮可换，不与 Chat 锁定）/ **Sense**（受监管的感官工具）/ **Chat**（消息通道，按月分片）。核心特性：Sense 调用监管、流式响应、两阶段执行（thinking → content / sense call → result）、Prompt 系统与 Skills。

## 架构分层

| 层 | 路径 | 模块文档 | 职责 |
|----|------|----------|------|
| Core | `src/core/` | [docs/core/](../docs/core/) | 框架抽象：类型、Adapter 注册表、Middleware 类、Sense 工厂 |
| Agent | `src/agent/` | [docs/agent/](../docs/agent/) | 具体实现：bootstrap/builder/runtimeResolver、中间件链、内置感官、Provider |
| Service | `src/service/` | [docs/service/](../docs/service/) | 服务层：WebSocket、RPC 路由、chat 流式、observer 副作用、审批 |
| DB | `src/db/` | [docs/db.md](../docs/db.md) | 持久化：多 sqlite 实例、soul.db + 按月分片 YYYY-MM.db |
| Utils | `src/utils/` | [docs/utils/](../docs/utils/) | 工具：config、drain、logger、hash/json/generator |
| 配置 | `.chery/` + `.chery/db/` | — | 运行时配置 + 数据库（不走打包，运行时读取） |
| 打包 | `scripts/` | [docs/web/pack-guide.md](../docs/web/pack-guide.md) | Electron 打包：`pnpm electron:pack` |

> 前端 `web/`（pnpm workspace 独立 package，Vue3 + Vite 8 + Electron 43）架构说明见 [docs/web/](../docs/web/)。

## 常用命令

```bash
pnpm dev              # 开发（vite build --ssr --watch + nodemon）
pnpm build            # Vite 8 SSR 打包到 dist/
node dist/index.js    # 运行编译产物（无 start 脚本，直接运行）
pnpm compile:senses   # 编译 .chery/senses/ 外部感官
pnpm test             # vitest（套件有预存问题，开发期仅关注 TSC 类型检查通过）
```

## 核心概念速查

- **Middleware 洋葱链**（外→内）：`checkpoint → sense → retry → chat`，`loop` 循环到无 senseCalls。详见 [agent/middleware.md](../docs/agent/middleware.md)。
- **Sense 监管等级**：`auto`(0) / `confirm`(1) / `manual`(2)；优先级：感官配置覆盖 > 感官内置声明 > `global.supervision`。详见 [core/sense.md](../docs/core/sense.md)。
- **审批**：core `approvalRegistry` 创建 Promise 并 await，service `ApprovalManager` 仅登记 id、转调 core 触发。详见 [agent/middleware.md](../docs/agent/middleware.md) + [service/chat.md](../docs/service/chat.md)。
- **主数据流**：`chat.send` → RPC router → `AgentBuilder.run` → Middleware 链 → LLM 流式 → service observer（DB 持久化 + 审批注册）→ WebSocket 推送。详见 [service/chat.md](../docs/service/chat.md)。

## 配置入口

- [.chery/config.yaml](../.chery/config.yaml)：`llm.brain.<name>`（provider/model/url/key）+ `sense_groups`（感官分组，`:level` 后缀覆盖监管等级）+ `global`（thinking/supervision/stream 等）+ `server`（port/web_port/transport）。`$ENV` 占位符从环境变量注入。
- [package.json](../package.json) `packConfig`：打包相关配置（Node 版本、代理、镜像），由 `scripts/pack-config.mjs` 读取，环境变量可覆盖。详见 [docs/web/pack-guide.md](../docs/web/pack-guide.md)。
- 配置目录由 `CHERY_DIR` 指定（默认 `.chery`）；WebSocket / Web 端口与传输格式以 `config.server` 为准（详见 [utils/README.md](../docs/utils/README.md)）。

## 文档导航

| 入口 | 内容 |
|------|------|
| [根 README](../README.md) | 项目综述、隐喻体系、启动指令、配置文件清单 |
| [docs/README.md](../docs/README.md) | **文档总索引（AI 入口）**：按模块 + 按主题双导航 |
| [docs/protocol.md](../docs/protocol.md) | WebSocket 协议规范（传输格式/消息结构/方法/错误码） |
| [docs/interaction.md](../docs/interaction.md) | 各 RPC 方法完整交互序列 |
| [docs/mock.md](../docs/mock.md) | Mock Provider 脚本化离线测试 |

## 约定

- **文档先于实现（Doc-First）**：每次修改代码前，先更新涉及的 `docs/` 模块文档，保证文档先于实现。先改代码后补文档视为违规；纯重构、格式化、修复 typo 可豁免。
- **TypeScript**：ESM（`"type":"module"`）、严格模式（`noUncheckedIndexedAccess`）、bundler 模块解析（Vite 8）、路径别名 `@/*`→`src/*`、`@test/*`→`test/*`。`interface`/`type` 用 `import type`，`class`/`enum`/函数用 `import`。
- **扩展**：新增 Provider / Sense（内置 / 外部）/ Middleware / Skill 的步骤，见对应模块文档的「扩展点」章节：
  - Provider → [agent/provider.md](../docs/agent/provider.md)
  - Sense → [core/sense.md](../docs/core/sense.md)（内置）/ [core/compiler.md](../docs/core/compiler.md)（外部）
  - Middleware → [agent/middleware.md](../docs/agent/middleware.md)
  - Skill → [agent/prompt.md](../docs/agent/prompt.md)

<!-- CODEGRAPH_START -->
## CodeGraph

In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files when you need to understand or locate code:

- **MCP tool** (when available): `codegraph_explore` answers most code questions in one call — the relevant symbols' verbatim source plus the call paths between them, including dynamic-dispatch hops grep can't follow. Name a file or symbol in the query to read its current line-numbered source. If it's listed but deferred, load it by name via tool search.
- **Shell** (always works): `codegraph explore "<symbol names or question>"` prints the same output.

If there is no `.codegraph/` directory, skip CodeGraph entirely — indexing is the user's decision.
<!-- CODEGRAPH_END -->
