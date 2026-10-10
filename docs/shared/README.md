# 跨端共享文档

本目录保存无法由单一前端或后端模块独占、必须由多个运行端共同遵守的事实。

QQ 新架构的组件边界见[QQ 平台新架构](./architecture/qqbot-platform.md)，插件与后端的消息字段见[QQ 插件协议](./protocol/qqbot-plugin.md)。

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
| 修改统一插件包、可信身份、请求视图、工具来源与生命周期 | [统一插件宿主](./architecture/ingress-plugins.md) |
| 修改 Manager 插件页面、动态资源、认证和双端版本 | [Manager 插件体系](./architecture/manager-plugins.md) |
| 修改 Manager 资源保存、业务接口与错误处理 | [Manager 管理模块](./architecture/manager-management.md) |
| 只改变单端实现，不改变共同契约 | 返回 [后端](../backend/README.md) 或 [前端](../frontend/README.md) 的对应模块入口 |
