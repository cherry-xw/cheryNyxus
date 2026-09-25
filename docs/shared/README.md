# 跨端共享文档

本目录保存无法由单一前端或后端模块独占、必须由多个运行端共同遵守的事实。

| 目录 | 内容 |
| --- | --- |
| [architecture/](./architecture/README.md) | 系统边界、Agent 编排、上下文纪元和权威时间线 |
| [protocol/](./protocol/README.md) | WebSocket/HTTP 契约、交互序列、错误模型和设备 profile |

共享文档只定义跨边界事实。具体实现入口继续由 [后端](../backend/README.md) 和 [前端](../frontend/README.md) 文档维护。
## 常见任务路由

| 修改意图 | 先读 |
| --- | --- |
| 修改跨端消息、错误或交互序列 | [共享协议](./protocol/README.md) |
| 修改 Agent 编排、上下文纪元或权威时间线 | [共享架构](./architecture/README.md) |
| 修改中转服务跨进程契约 | [中转协议](./protocol/relay.md) |
| 只改变单端实现，不改变共同契约 | 返回 [后端](../backend/README.md) 或 [前端](../frontend/README.md) 的对应模块入口 |
