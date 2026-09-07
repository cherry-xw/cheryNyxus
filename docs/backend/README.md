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

跨端消息和状态契约不在后端重复定义，统一见 [共享协议](../shared/protocol/README.md)；跨模块系统边界见 [共享架构](../shared/architecture/README.md)。
