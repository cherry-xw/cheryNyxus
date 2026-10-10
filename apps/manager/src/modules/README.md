# Manager 动态管理接口

本目录负责已安装 Backend 包的描述、受保护资源和有限管理分发，不负责包业务实现、聊天或业务文件保存。契约见[Manager 插件](../../../../docs/shared/architecture/manager-plugins.md)，资源保存见[管理业务](../../../../docs/shared/architecture/manager-management.md)。

| 修改意图 | 入口 | 验证 |
| --- | --- | --- |
| 动态目录、资源、有限操作 | dynamic.ts 的 DynamicModules | apps/manager/test/dynamicPlugins.test.ts |
| 管理连接与认证 | capabilities/rpc.ts 的 BackendRpcClient | apps/manager/test/modules/rpc.test.ts |
| 页面数据类型 | contracts.ts | pnpm manager:type-check |

流程：server.ts 先授权 Session/Origin → DynamicModules 读取 Backend 描述 → 根据登记路径调用 ingress.management.call 或 ui.read → 校验响应与版本 → 返回安全结果。静态工厂和固定启用列表不存在。设置与 QQ 业务分别在 platform 下的独立 Backend 包中实现。

目标从 Manager 配置读取，凭据只在服务端；challenge/login 后建立认证 WS。调用有界，不重试未知写入，不从本地业务文件兜底。停用保留管理注册，卸载撤销资源和接口。Backend 失败不等于 Manager Session 失效。

验证运行 pnpm manager:test、pnpm manager:type-check、pnpm manager:build。测试使用合成数据及临时 HTTP/WS，不调用真实 QQ/模型。部署与视觉验收另行执行。
