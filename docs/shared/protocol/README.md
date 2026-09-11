# 共享协议

| 文档 | 定位 |
| --- | --- |
| [workflow.md](./workflow.md) | 现行粗粒度观察，以及目标步骤身份、生命周期、增量同步与分页契约 |
| [websocket.md](./websocket.md) | WebSocket、HTTP、RPC、消息结构和错误码的权威 wire 契约 |
| [interactions.md](./interactions.md) | 端到端交互顺序、恢复、审批和异常路径 |
| [errors.md](./errors.md) | 用户错误、协议错误与日志诊断信息的分层模型 |
| [profiles/](./profiles/README.md) | 面向特定客户端能力的协议投影 |

协议字段只在权威协议文档中定义；后端和前端模块文档只描述各自如何实现或消费这些契约。
