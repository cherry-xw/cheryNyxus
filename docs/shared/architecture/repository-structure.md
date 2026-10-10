# 仓库组件结构

源码按组件职责组织；源码目录不是持久运行数据目录。目录调整不迁移 `.chery`、数据库、登录数据或凭据文件。

| 目录 | 职责与验证入口 |
| --- | --- |
| `apps/backend/src`、`apps/backend/test` | 核心运行服务、Agent、工具和统一插件宿主。`pnpm build`、`pnpm test:backend`。 |
| `apps/manager/src`、`apps/manager/ui`、`apps/manager/test` | 内置管理认证、可信后端连接和通用插件管理。页面与服务器分别构建；`pnpm manager:test`。 |
| `plugins/qq` | QQ 业务、专用页面、配置清单、Skill 与脚本；`pnpm qq-ingress:build` 生成完整 `dist` 包。 |
| `plugins/settings` | 设置业务和管理页面；`pnpm settings-ingress:build` 生成完整 `dist` 包。 |
| `packages/protocol` | 跨进程请求、响应与校验契约。 |
| `packages/plugin-api` | 插件公共结构类型与生命周期契约；只依赖协议包及 Zod，不导入 Backend。 |
| `apps/web`、`apps/relay` | 各自独立客户端或连接服务；不承担 QQ 业务。 |
| `platform` | NapCat 适配器、ESP32 与 ADV 设备代码及专用测试。 |
| `.chery.template` | 默认全局资源；QQ 专用 Skill 不放入全局模板。 |
| `<组件>/deploy` | 组件镜像、启动和部署资产。 |
| `deployment` | 跨组件 Compose、代理组合与示例环境；持久目录以实际部署配置为准。 |
| 根 `test/deployment` | 跨组件联合检查。 |
| 根 `scripts`、`tools`、`docs` | 全仓维护工具与文档。 |

QQ Skill 由 QQ 包清单声明，宿主在成功启动后登记来源，停用时撤销。请求须同时通过可信渠道身份和角色插件白名单；模型不能用 Skill 名绕过身份过滤。公共边界见[统一插件宿主](ingress-plugins.md)。

Manager 使用显式配置的通用受保护连接凭据接口；QQ 展示与轮换说明归 QQ 插件页面，接口边界见[Manager 插件](manager-plugins.md)。当前 apps 目录调整的隔离交付与未完成验收由[apps 目录调整计划](../../plan/apps-layout-migration/README.md)维护。
