# cheryNyxus 后端与插件架构及命名

项目命名强制规则唯一来源为 [AGENTS.md](../../../AGENTS.md)。本文区分当前实现与确定的命名目标，不表示运行环境已完成重命名。

## 组件与职责

| 组件 | 运行位置 | 职责 | 不负责 |
| --- | --- | --- | --- |
| `cheryNyxus-runtime` | 独立运行服务 | AI 执行、模型、工具、会话、记忆、HTTP/WS 服务 | QQ 登录 |
| `cheryNyxus-extension-host` | 运行服务进程内，`apps/backend/src/service/ingress/` | 扩展注册、包校验、加载、配置快照、生命周期、公共能力接口 | 固定 QQ 业务、控制面登录 |
| `cherynyxus-qq-module` | 扩展宿主加载的业务模块；现有源码 `plugins/qq/` | QQ 身份绑定、入站、权限、目标绑定、队列、回复编排、发送确认与状态 | 作为控制面子进程运行、QQ 登录、重复实现模型执行器 |
| `cheryNyxus-qq-adapter-napcat` | NapCatQQ 进程内的逻辑适配器；现有源码 `platform/napcat-plugin/` | QQ 事件适配、可信身份发现、运行服务连接、QQ 消息发送与结果回报 | 白名单决策、模型执行、独立业务队列 |
| `cheryNyxus-control` | 独立控制面，`apps/manager/` | 登录、管理页面、核心资源配置、运行状态和扩展配置客户端 | QQ 实时转发、运行时扩展宿主 |
| cheryNyxus Agent Web | 浏览器前端，`apps/web/` | Agent 对话与工作台 | 代替 Manager 管理页 |

`cherynyxus-qq-module` 是运行服务内的 QQ 业务模块，不是独立服务；不应把业务执行搬入控制面。

NapCat 插件的技术 ID为 `napcat-plugin-cherynyxus`。它用于 NapCat 的包元数据、启用配置、路由和部署目录；用户可见名称为 `NapCat Plugin Chery Nyxus`，逻辑架构名称仍为 `cheryNyxus-qq-adapter-napcat`。

## 两条不同的通信路径

实时消息：

```text
QQ ↔ NapCatQQ ↔ NapCat 兼容插件 ID `napcat-plugin-cherynyxus`
   ↔ `cheryNyxus-runtime` WebSocket ↔ `cherynyxus-qq-module`
   ↔ `cheryNyxus-runtime` 核心 AI 能力
```

管理操作：

```text
用户浏览器 → Manager Session → Manager 管理接口
           → Backend 管理认证 / Core RPC → 核心资源或后端插件
```

关闭 Manager 不应停止 QQ 实时消息处理。Backend 插件由统一宿主管理，不增加独立 QQ 后端服务。

## 命名目标与尚未迁移的现状

- 唯一正式项目拼写：`cheryNyxus`。
- 运行层、控制面、扩展宿主、QQ 业务模块、适配器和协议使用推荐职责命名。
- NapCat 技术 ID固定为 `napcat-plugin-cherynyxus`，用户可见名为 `NapCat Plugin Chery Nyxus`。
- NapCat 的允许列表、包元数据、启用配置、API 路由、部署目录和配置目录必须统一使用该 ID；加载验收以该 ID被扫描、初始化和加载为准。
- 后端包清单、注册表和协议中的业务职责名称应使用 `cherynyxus-qq-module`、`cheryNyxus-qq-adapter-napcat` 和 `cheryNyxus-qq-protocol`，不能把 NapCat 技术 ID当作后端业务模块名称。
- 当前后端包清单、注册表与协议仍存在历史标识；须核对实际清单及注册表后同步迁移，不能以显示名修改冒充运行时迁移。
- NapCat 技术 ID已经统一为 `napcat-plugin-cherynyxus`；后续改动必须保持加载器允许项、包元数据、启用配置、API 路由与配置目录一致，并保留登录及配置数据。
- 当前 QQ RPC 使用 `qq.*`、请求认证头使用 `X-QQBot-Token`；这些是现行协议事实，不是已确认的新协议命名。新的方法前缀、认证头、环境变量、文件名和路由规则仍需讨论确定，不能从插件名称自行推导。

## 通信凭据边界

NapCat 插件通信 Token 用于 NapCat 插件连接 Backend，不是 Manager 登录密码、Manager Session、Manager 机器密钥或 Backend 管理凭据。Manager 提供管理入口，不因此变成实时中转。

用户已确认：通信 Token 生成后允许在已登录 Manager 和受保护的 NapCat 配置页面反复查看，不实行一次性展示。公共状态、日志和任务记录仍不应返回秘密。

当前 Backend 从部署注入的 `QQBOT_PLATFORM_TOKEN` 读取认证值；Manager 生成后的保存位置、生效方式和此读取路径的统一尚未实现。不得宣称生成按钮等于认证连接成功。

## 整理范围和实施边界

先确定组件名称、包 ID、协议前缀、认证字段、路由与配置目录的对应关系，再实施迁移。当前文档整理不改变服务、协议或持久化数据；Token 功能开发在命名讨论期间暂停。

宿主公共接口与生命周期见 [后端接入插件](ingress-plugins.md)，管理边界见 [Manager 管理模块](manager-management.md)。其中历史名称须随正式迁移同步更新，不能作为新命名的依据。
