# 后端文档

本目录对应仓库的 `src/`，按稳定源码模块维护后端职责、接口和实现说明。

| 模块 | 源码 | 内容 |
| --- | --- | --- |
| [agent/](./agent/README.md) | `src/agent/` | Agent 装配、中间件、Provider、感官、角色、提示词与模型能力 |
| [core/](./core/README.md) | `src/core/` | 框架抽象、消息、LLM、Middleware、Sense 与 MCP 契约 |
| [db/](./db/README.md) | `src/db/` | 数据库、表结构、迁移、分片和状态判定 |
| [memory/](./memory/README.md) | `src/memory/` | 跨会话记忆、维护和淘汰机制 |
| [service/](./service/README.md) | `src/service/` | HTTP、WebSocket、RPC、Chat 与业务服务 |
| [utils/](./utils/README.md) | `src/utils/` | 配置、日志、密钥存储及通用工具 |

## 常见任务路由

| 修改意图 | 先读 |
| --- | --- |
| 修改 Agent 装配、模型能力、Provider、角色或提示词 | [Agent 模块](./agent/README.md) |
| 修改消息、Middleware、Sense、MCP 或核心类型 | [Core 模块](./core/README.md) |
| 修改数据库表、迁移、状态或记忆存储 | [数据库模块](./db/README.md) 或 [记忆模块](./memory/README.md) |
| 修改 HTTP、WebSocket、RPC、会话或工作区服务 | [服务模块](./service/README.md) |
| 修改配置、日志、密钥和通用基础能力 | [工具模块](./utils/README.md) |

跨端消息和状态契约不在后端重复定义，统一见 [共享协议](../shared/protocol/README.md)；跨模块系统边界见 [共享架构](../shared/architecture/README.md)。
