# 共享协议

| 文档 | 定位 |
| --- | --- |
| [workflow.md](./workflow.md) | 执行步骤身份、生命周期、持久记录与恢复契约 |
| [websocket.md](./websocket.md) | WebSocket、HTTP、RPC、消息结构和错误码的权威 wire 契约 |
| [interactions.md](./interactions.md) | 端到端交互顺序、恢复、审批和异常路径 |
| [errors.md](./errors.md) | 用户错误、协议错误与日志诊断信息的分层模型 |
| [workspace-files-terminal.md](./workspace-files-terminal.md) | 工作台文件引用、工作区文件读写边界与 Terminal 会话 RPC |
| [relay.md](./relay.md) | 中转设备握手、Backend ID、列表发现、会话绑定、代理白名单与错误契约 |
| [browser-session.md](./browser-session.md) | 业务同源浏览器会话、修订/幂等、单次WS票据、用户证明和bootstrap |
| [manager-auth.md](./manager-auth.md) | Manager 独立账号、浏览器 Session、OIDC 和隔离的本机机器接口 |
| [qqbot-plugin.md](./qqbot-plugin.md) | NapCat 插件与 Docker 后端的 WebSocket RPC、事件和恢复契约 |
| [qq-identity.md](./qq-identity.md) | NapCat 受限身份来源、selfId 验证、拒绝和脱敏诊断契约 |
| [profiles/](./profiles/README.md) | 面向特定客户端能力的协议投影 |

协议字段只在权威协议文档中定义；后端和前端模块文档只描述各自如何实现或消费这些契约。
