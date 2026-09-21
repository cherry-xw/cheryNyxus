# 独立后端与中转网关

**文档创建时间：** 2026-09-20T17:16:52+08:00

**状态：** 执行中

## 1. 计划定位

本计划负责把[独立后端与中转网关需求](../../shared/architecture/relay-gateway-requirements.md)落实为可交付的后端、中转、本地管理器、前端、Electron、部署配置和验证资产。

需求文档是跨模块契约和稳定事实的 owner；本文件只记录：

- 实施顺序和依赖；
- 每个阶段的实现边界、交付物和完成条件；
- 代码、配置、文档和测试入口；
- 当前仍会阻塞实现的决策；
- 跨会话恢复和最终验收安排。

不在本计划中重新定义 HTTP、WebSocket、认证或路径契约。契约落定后，应迁入共享协议、后端服务、前端和部署文档；计划只保留链接和验证入口。

## 2. 目标与边界

### 2.1 最终交付目标

用户可以在本地独立运行 CheryNyxus 后端：

1. 后端和 rathole client 主动连接公网中转，不要求开放本地业务端口；
2. 浏览器和 Electron 前端通过在线列表或手动 `backendId` 选择一个后端；
3. 前端通过发现 API 获取实际 HTTP/WS 地址，不依赖固定业务端口；
4. 后端同时支持 Pocket ID OIDC 和现有用户名密码登录；
5. 密码连续失败触发 15 次一档、逐档翻倍、最长 1 小时的冷却；
6. 独立本地管理器在 `127.0.0.1:39980` 提供状态、连接信息、凭据、Agent 统计和启停操作；
7. Linux 使用 systemd，Windows 使用无控制台窗口的托盘启动器；
8. Electron 只承载前端，不启动、打包或管理后端；
9. nginx、静态资源、HTTP、WebSocket、Cookie 和 OIDC 回调支持域名子路径部署；
10. 中转只处理 CheryNyxus 规定的 HTTP `/api/*` 和 WebSocket 控制流量，不成为通用代理。

### 2.2 非目标

- 不实现任意 TCP、任意 HTTP、文件共享或端口转发服务；
- 不把邀请码作为前端访问凭据；
- 不要求前端同时操作多个后端；
- 不在仓库内实现 Pocket ID；
- 不把后端重新塞回 Electron；
- 不在本任务中重写现有 Agent、数据库或 RPC 业务逻辑；
- 不把中转日志作为凭据、Cookie、授权码或 token 的存储位置。

## 3. 权威文档与现有入口

| 主题           | 权威文档/入口                                                                                                       | 本计划中的使用方式                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 总体需求和架构 | [`docs/shared/architecture/relay-gateway-requirements.md`](../../shared/architecture/relay-gateway-requirements.md) | 所有阶段的稳定边界和验收目标                        |
| 后端服务装配   | [`docs/backend/service/README.md`](../../backend/service/README.md)                                                 | `src/service/index.ts`、HTTP、WS 和启动生命周期     |
| 后端 HTTP      | [`docs/backend/service/http.md`](../../backend/service/http.md)                                                     | `/api/config`、静态服务和认证入口                   |
| 后端 WebSocket | [`docs/backend/service/websocket.md`](../../backend/service/websocket.md)                                           | Upgrade、来源检查、会话和传输行为                   |
| 后端认证       | [`src/service/auth/index.ts`](../../../src/service/auth/index.ts)                                                   | OIDC、密码认证、Cookie、loopback 边界和冷却实现入口 |
| 后端启动       | [`src/index.ts`](../../../src/index.ts)                                                                             | 独立进程、guardian、信号和进程退出                  |
| 前端连接抽象   | [`docs/frontend/env.md`](../../frontend/env.md)                                                                     | `platform.ts`、发现 API、HTTP/WS 地址和重连         |
| 前端认证       | [`docs/frontend/auth-login.md`](../../frontend/auth-login.md)                                                       | 登录对话框、登录能力发现和双登录入口                |
| 前端部署       | [`docs/frontend/deployment.md`](../../frontend/deployment.md)                                                       | 删除旧 Electron 内置后端描述并补充独立后端模式      |
| Electron       | [`docs/frontend/electron.md`](../../frontend/electron.md)                                                           | 主进程、preload 和纯前端容器边界                    |
| 测试边界       | [`docs/quality/testing/baseline.md`](../../quality/testing/baseline.md)                                             | 自动检查、浏览器人工验收和回归范围                  |

计划内的协议草案不能与共享协议形成第二个 owner；在 A 阶段落定后，应把稳定字段迁入 `docs/shared/protocol/`，此处只链接结果。

## 4. 运行拓扑和数据流

```text
本地机器
  本地管理器 :39980
    ├─ 启停和监控 CheryNyxus 后端
    ├─ 启停和监控 rathole client
    ├─ 保存/读取本地凭据与运行摘要
    └─ 提供本地管理页面和控制 API
  CheryNyxus 后端
    ├─ 可配置 HTTP 端口
    ├─ 可配置 WebSocket 端口
    ├─ /api/config 动态发现
    └─ HTTP/WS 用户认证
  rathole client
        │ 主动出站连接
        ▼
公网服务器
  rathole server + 中转控制服务
    ├─ 后端在线状态和 Backend ID
    ├─ CheryNyxus 路径白名单
    ├─ HTTP/WS 反向路由
    ├─ 来源限流、审计和资源限制
    └─ 不记录用户凭据和会话机密
  nginx
    ├─ HTTPS
    ├─ 前端静态资源
    ├─ 可配置路径前缀
    └─ HTTP/WS Upgrade 转发
  Pocket ID
        │ OIDC 授权码 + PKCE
        ▼
浏览器 / Electron
  一个会话绑定一个 backendId
  通过发现结果访问 HTTP 和 WebSocket
```

关键数据流必须保持以下顺序：

1. 本地管理器启动后端并读取实际 HTTP/WS 监听信息；
2. rathole client 主动连接中转，中转只建立 CheryNyxus 专用服务映射；
3. 中转更新后端在线状态，不向浏览器下发本地真实端口；
4. 前端读取列表或接受手动 `backendId`；
5. 前端从本地或中转发现 API 获取有效 HTTP/WS 地址；
6. 前端先完成选定后端的 Pocket ID 或用户名密码认证；
7. 认证后的 HTTP 和 WS 请求沿同一后端绑定关系转发；
8. 连接断开、后端重启或端口变化时重新发现，不继续盲用旧端口。

## 5. 先决决策和阻塞项

这些事项必须在相应阶段的代码实现前落定；未落定时只能写协议草案和测试夹具，不能把猜测实现成固定契约。

| 编号 | 必须落定的事项                     | 当前已知决定                                                                                                 | 负责阶段 | 阻塞影响                                       |
| ---- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------- |
| D1   | “无需注册、直接连接”的后端身份握手 | 已确认：用户设置易读 Backend ID；本地 Ed25519 密钥挑战签名；中转首次信任持久绑定公钥；密码只用于后端用户登录 | A/B      | 已解除；撤销只走部署方本机管理操作             |
| D2   | rathole service 映射               | 已确认：HTTP/WS 两个私有映射，只绑定中转机 loopback；服务名和短期 token 由中转下发                           | B        | 已解除；B 固定版本和配置生命周期               |
| D3   | 中转列表访问边界                   | 已确认：公开最小列表/发现；只返回 ID、名称、状态、公开能力和网关地址；控制面仍由目标后端认证                 | A/E      | 已解除                                         |
| D4   | 远程入口与 loopback 信任边界       | 已确认：新增独立远程 HTTP/WS 入口并强制认证；本地入口保留 loopback 豁免                                      | C        | 已解除                                         |
| D5   | OIDC 回调拓扑                      | 已确认：中转保持同源路由并转发给目标后端；后端校验 state、换码、设置 Cookie                                  | C/E/F    | 已解除                                         |
| D6   | 凭据文件与密码变更关系             | 本地受保护文件可重复查看；不经中转                                                                           | D/C      | 必须定义首次生成、手动修改、重新生成和文件权限 |
| D7   | 管理器与后端 IPC                   | 已确认：管理器作为父进程管理 guardian 与 rathole，生命周期走子进程 IPC；39980 使用本机控制密钥               | D        | 已解除；D 细化停止中状态                       |
| D8   | 子路径规则                         | 已确认：relay 去 Backend ID 路由段，向专用远程入口传递可信公共前缀；前端、Cookie 和 OIDC 使用该前缀          | F/G      | 已解除                                         |

任何 D1-D8 的变更都要同步需求文档、受影响阶段、最终验证清单和恢复检查点。

## 6. 实施批次总览

状态统一使用 `未开始 / 进行中 / 阻塞 / 已完成`。复杂度用于选择执行能力，不表示工期。

| 编号 | 小任务                      | 状态   | 复杂度 | 复杂度依据                                                                                     | 依赖         | 主要交付物                                                                                                         |
| ---- | --------------------------- | ------ | ------ | ---------------------------------------------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------ |
| A    | 中转协议与控制层            | 已完成 | 5      | 新建跨进程连接协议、列表、路由白名单、状态、限流和审计边界，涉及公共契约                       | 需求文档     | `relay/` 控制服务、共享协议、协议测试、D1/D3                                                                       |
| B    | rathole 连接与动态下发      | 已完成 | 4      | 外部二进制、出站连接、配置生成、断线恢复和资源隔离                                             | A、D1        | rathole server/client 配置、连接管理、B 阶段测试                                                                   |
| C    | 后端动态端口与认证安全      | 已完成 | 5      | 修改既有 HTTP/WS/Auth 入口，涉及 loopback 安全、双认证、Cookie、冷却和兼容                     | A、B、D4、D5 | 后端远程入口、动态发现、认证安全、C 阶段测试                                                                       |
| D    | 本地管理器与运行入口        | 已完成 | 5      | 新的常驻控制进程、跨平台进程管理、凭据文件、统计和服务安装                                     | C、D6、D7    | `39980` 管理器、CLI、systemd、Windows 启动器                                                                       |
| E    | 前端连接发现与双登录        | 已完成 | 4      | 改变前端连接目标、缓存、重连和登录状态，同时保持旧直连兼容；不新增 Backend ID 选择器           | A、C、D      | 本地管理器发现、动态 HTTP/WS、手动远程/relay 路径兼容、现有登录状态适配                                            |
| F    | Electron 前端化与子路径适配 | 已完成 | 4      | 删除现有后端生命周期耦合，改造 preload、打包和资源/路径生成                                    | C、D、E、D8  | 纯前端 Electron、子路径 URL 适配、资源静态检查                                                                     |
| G    | nginx、发布和操作文档       | 已完成 | 3      | 把多个进程和外部服务整理为可复用部署方式，涉及配置模板和平台说明                               | B、D、E、F   | nginx 模板、安装脚本、运行指南、配置说明                                                                           |
| H    | 综合验证与用户验收          | 进行中 | 5      | 需要真实多进程、网络、认证、动态端口、子路径和桌面/系统服务验收；阶段一受外部 Web 类型错误阻塞 | A-G          | [`H-verification.md`](H-verification.md)、[`verify/manual-final.md`](verify/manual-final.md)、自动清单和人工操作卡 |

## 7. 批次实施规划

### A. 中转协议与控制层

**目标：** 先定义中转只服务 CheryNyxus 的公共协议边界，再实现可测试的控制服务；不先实现任意反向代理。

**实现范围：**

- 新建 `relay/` 服务入口和配置加载；
- 定义 Backend ID、在线状态、连接能力、配置版本和断线状态；
- 定义后端直连握手、配置下发和心跳语义；
- 定义前端后端列表、手动 Backend ID 查询和连接发现响应；
- 定义 HTTP 路径白名单：只允许目标后端的 `/api/*`；
- 定义 WebSocket Upgrade 路径和目标后端绑定；
- 定义一个浏览器会话绑定一个 Backend ID 的生命周期；
- 添加请求大小、连接数、速率、超时、空闲连接和在线后端数量限制；
- 规定日志字段只包含 request id、Backend ID、路径类别、状态码、耗时和失败原因类别，不记录凭据；
- 为不存在、离线、冲突、协议版本不兼容和资源超限定义稳定错误。

**不做：**

- 不在 A 阶段实现 Pocket ID 登录；
- 不让中转解析或保存后端用户名密码；
- 不把 rathole 原始 TCP 流暴露为通用端口；
- 不在没有 D4 方案时放行 loopback 管理员逻辑。

**交付物：**

- `relay/` 控制服务源代码和配置校验；
- `docs/shared/protocol/relay.md` 或现有共享协议中的 relay 专题；
- 中转 HTTP/WS 路由与拒绝规则测试；
- D1、D2 前置协议决策记录迁入权威文档。

**完成条件：**

- 未知路径、未知 Backend ID、越权后端和任意代理请求均有可断言的拒绝结果；
- 列表和发现响应不包含本地真实端口或敏感配置；
- 控制服务能在没有 rathole 实例时用测试适配器运行；
- 协议字段、错误和状态可以被 B、C、E 直接消费。

**定向验证入口：** relay 单元/集成测试、HTTP 路由白名单测试、WS Upgrade 拒绝测试、日志脱敏测试。

### B. rathole 连接与动态下发

**目标：** 让本地管理器可以启动 rathole client，后端主动建立专用连接，并在中转在线状态中可见。

**实现范围：**

- 固定 rathole 版本、下载来源、校验和、平台文件名和启动参数；
- 定义 server/client 配置模板的生成与临时文件权限；
- 定义“直接连接并下发配置”而非用户注册流程的握手方式；
- 绑定 Backend ID、设备凭据、服务名和连接版本；
- 处理首次连接、重复连接、断线、重连、配置版本变化和撤销；
- 确保 rathole 只映射 CheryNyxus HTTP/WS，不暴露 39980 或任意本地端口；
- 输出可供本地管理器读取的在线状态、最后心跳和错误类别；
- 为 rathole 不存在、版本错误、token 错误、连接超时和服务映射错误提供可读状态。

**交付物：**

- rathole 进程适配器；
- server/client 配置生成器和校验器；
- 测试用假 rathole 进程或可替换 transport；
- `docs/relay/README.md`、部署文档中的版本和权限说明；
- 断线/重连/撤销测试。

**完成条件：**

- 后端下线或网络断开后，中转状态在限定时间内变为离线；
- 重连不会产生重复 Backend ID、重复路由或失效旧配置继续可用；
- 39980、后端管理接口和任意非白名单端口无法通过 rathole 访问；
- 所有设备 token 和配置密钥不进入日志。

**定向验证入口：** 配置生成测试、子进程退出测试、断线恢复测试、端口暴露负向测试。

### C. 后端动态端口与认证安全

**目标：** 在不破坏本地直连行为的前提下，为隧道访问建立强制认证边界，并让前端只依赖发现结果连接动态端口。

**实现范围：**

- 扩展 `/api/config` 为权威连接发现响应，优先返回完整地址/路径，保留旧端口字段兼容；
- 让 HTTP 和 WS 监听端口继续可配置，不把默认值写成协议要求；
- 增加或隔离专用远程 HTTP/WS 入口，明确隧道请求不能获得本机 loopback 管理员豁免；
- 保留普通本地 loopback 行为，确保既有本地访问不被改变；
- 将密码认证和 OIDC 配置拆成可同时启用的能力；
- 增加登录能力发现接口并定义其是否公开、返回哪些非敏感字段；
- 复用现有密码 challenge、scrypt、access/refresh token 流程；
- 添加密码失败计数、15 次分档、5 分钟起步、翻倍和 1 小时上限；
- 冷却期间同时拒绝新 challenge 和旧 challenge 提交，并返回 `429`/`Retry-After`；
- 成功密码登录清零失败状态；Pocket ID 失败不计入密码冷却；
- 为 OIDC 回调、state、Cookie Path、trusted origin 和子路径传递准备配置入口；
- 确保中转转发 Cookie、Set-Cookie、Host、Origin 和 forwarded proto 时不落日志。

**兼容要求：**

- 现有本地用户名密码登录仍可工作；
- 仅启用 OIDC、仅启用密码、两者同时启用三种配置均可启动；
- 旧配置字段在迁移期间继续读取，并明确冲突优先级；
- 本地直连 WebSocket 不因新增远程入口而改变认证结果。

**交付物：**

- `src/service/auth/index.ts` 及相关配置/会话改造；
- `src/service/http/index.ts`、`src/service/websocket/`、`src/service/index.ts` 的远程入口和发现改造；
- 认证能力发现、密码冷却和 loopback 隔离测试；
- `docs/backend/service/auth.md`、HTTP/WS 文档同步。

**完成条件：**

- 远程隧道流量不能通过来源地址伪造触发管理员权限；
- 第 15 次失败进入 5 分钟冷却，后续档位翻倍且不超过 1 小时；
- 冷却期间重新获取 challenge 无法绕过；
- OIDC 和密码登录可同时开启且互不计数；
- 端口变化后发现响应能被前端和中转适配器消费。

**定向验证入口：** `src/service/auth` 相关测试、HTTP/WS auth 测试、配置兼容测试、动态端口启动测试、负向 loopback 测试。

### D. 本地管理器与运行入口

**目标：** 提供不依赖 Electron 的跨平台本地生命周期管理和管理页面；后端停止时 39980 仍然可用。

**实现范围：**

- 建立独立管理器进程，默认监听 `127.0.0.1:39980`，`CHERY_MANAGER_HOST` 可开放内网访问（见 [backend-runtime.md](../../guides/backend-runtime.md)）；
- 定义管理器到后端、rathole client 的进程控制和状态读取协议；
- 支持启动、停止、重启、退出码、崩溃、端口占用和启动超时；
- 提供 `/api/connection`、运行状态、隧道状态、Backend ID、实际端口和 Agent 统计；
- 提供本地页面的启停、重启、复制信息和错误展示；
- 生成/读取受保护凭据文件，Linux 使用 `0600`，Windows 使用当前用户 ACL；
- 定义用户名密码生成、重复查看、主动修改、重新生成和凭据文件不一致提示；
- 提供 CLI：`info`、`service install`、`status`、`restart`、`uninstall` 等；
- Linux 提供 user/system systemd 安装；
- Windows 提供无控制台窗口托盘启动器，点击后使用默认浏览器打开 39980；
- 管理器不把凭据通过中转发送，不把凭据写入普通日志。

**交付物：**

- 本地管理器源代码和管理页面；
- CLI 入口及帮助文本；
- Linux systemd unit、安装/卸载脚本；
- Windows 托盘启动器和状态菜单；
- 本地凭据文件格式、权限处理和迁移说明；
- `docs/guides/backend-runtime.md`。

**完成条件：**

- 后端停止后 39980 仍能打开并执行重新启动；
- 管理器能区分后端、rathole 和自身状态；
- 管理器重启不会误删 Backend ID 或凭据；
- 非本机连接默认无法访问 39980；开放内网访问时页面与全部 `/api/*` 都须携带启动日志 URL 上的管理密钥；
- Windows 不出现控制台窗口；Linux systemd 能启动、停止、重启和自动恢复。

**定向验证入口：** 管理器 API 测试、凭据权限测试、CLI 命令测试、进程退出/重启测试、systemd unit 静态检查。Windows 托盘和真实 systemd 操作只进入 H 的人工清单。

### E. 前端连接发现与双登录

**目标：** 把前端从“按平台猜后端”改为“按连接目标和发现结果连接”，并在同一登录界面提供 Pocket ID 与用户名密码。

**实现范围：**

- 在 `web/src/services/platform.ts` 建立连接目标、HTTP/WS 地址、路径前缀和发现响应的统一模型；
- 在 `web/src/services/ws.ts` 处理动态 WS URL、刷新发现、端口变化和断线重连；
- 把 Electron、浏览器、直连和中转从后端身份中解耦；
- 支持本地管理器发现入口、中转发现入口和用户手动 HTTP/WS 地址；
- 支持在线 Backend ID 列表、手动 Backend ID 查询、离线/不存在/无权限提示；
- 一个浏览器会话锁定一个后端，切换后清理旧后端的 Cookie、token、WS 和缓存；
- 增加登录能力发现；根据能力显示 Pocket ID 和用户名密码入口；
- Pocket ID 使用浏览器跳转回调，密码继续使用现有 challenge/login/refresh 逻辑；
- Cookie 模式使用 `credentials: include`，token 模式保持现有兼容路径；
- 处理中转下的 `/api/auth/login`、callback、me、logout 和 WS Cookie；
- 所有 URL 由公共路径前缀生成，不写死根路径 `/api` 或 `/ws`。

**交付物：**

- `web/src/services/platform.ts`、`ws.ts`、`authContext.ts`、`stores/auth.ts` 的连接/认证改造；
- `ServerLoginDialog.vue` 的双登录和 Backend ID 选择界面；
- 连接目标和发现响应的前端模型测试；
- `docs/frontend/relay-mode.md`、`docs/frontend/env.md`、`docs/frontend/auth-login.md`。

**完成条件：**

- 前端不依赖固定 8182/8183；
- 中转模式不把真实后端端口暴露到浏览器；
- HTTP/WS 断线后重新发现并连接新端口；
- 两种登录方式可同时显示、分别完成并正确退出；
- 切换 Backend ID 后不会把旧后端会话发送给新后端。

**定向验证入口：** platform/ws/auth store 单元测试、登录能力显示测试、发现失败和重连测试、Cookie/WS 请求选项测试。

### F. Electron 前端化与子路径适配

**目标：** 移除 Electron 对后端进程和固定端口的依赖，使 Electron 成为与浏览器等价的前端容器。

**实现范围：**

- 修改 `web/electron/main.ts`，删除后端 spawn、等待、guardian、重启和后端环境注入；
- 修改 `web/electron/preload.ts`，删除后端配置、端口和刷新入口，只保留纯桌面能力；
- 修改 `web/electron-builder.yml` 和打包脚本，移除后端 bundle、Node runtime、`.chery` 模板等资源；
- 保留窗口、菜单、目录选择等确有桌面职责的桥接；
- 让 Electron 首次启动显示连接目标选择或默认本地管理器发现入口，而非假设内置后端；
- 处理 Electron `file://`、开发服务器和生产子路径的统一 URL 生成；
- 使静态资源 base、API、WS Upgrade、OIDC redirect、Cookie Path 与公共前缀一致；
- 同步 nginx 对前缀的保留/去除策略和 Vite/Electron 构建配置；
- 保留浏览器根路径和子路径两类直连回归覆盖。

**交付物：**

- Electron 纯前端主进程/preload；
- 打包配置和资源清单更新；
- 子路径 URL 解析和构建配置；
- `docs/frontend/electron.md`、`docs/frontend/deployment.md`、`docs/frontend/env.md` 更新。

**完成条件：**

- Electron 安装包不包含后端运行所需资源；
- Electron 启动不会产生后端子进程；
- Electron 可连接本地、远程和中转后端；
- `/nyxus/` 等前缀下静态资源、API、WS、Cookie 和 OIDC 回调均使用同一前缀；
- 根路径旧部署方式仍可工作。

**定向验证入口：** TypeScript 类型检查、Electron 打包资源清单检查、URL/base 配置单元测试、构建产物静态扫描。Electron 实机操作只进入 H。

### G. nginx、发布和操作文档

**目标：** 把 relay、rathole、后端、管理器、Pocket ID 和前端的实际部署步骤整理成可重复执行的交付方式。

**实现范围：**

- nginx HTTPS、静态文件、子路径、HTTP API 和 WebSocket Upgrade 配置模板；
- 明确 `Host`、`Origin`、`Cookie`、`Set-Cookie`、`X-Forwarded-Proto` 和 `X-Forwarded-Host` 的转发规则；
- relay 服务安装、环境变量、日志、权限、限流和健康检查；
- rathole 二进制版本、校验和、server/client 配置和升级步骤；
- 外部 Pocket ID OIDC Client、回调 URL、issuer discovery、管理员映射和 trusted origin 配置；
- Windows 后端包、托盘启动器和凭据查看步骤；
- Linux 后端包、systemd user/system 服务和 CLI 步骤；
- 动态端口、39980 固定管理端口和浏览器连接地址的区别；
- 故障排查：后端离线、rathole 断线、OIDC 回调错误、Cookie 丢失、WS 失败、路径前缀错误和端口冲突；
- 一键部署前的安全检查和最小权限说明。

**交付物：**

- nginx 配置模板；
- relay/rathole/后端安装脚本或命令；
- `docs/guides/relay-deployment.md`；
- `.chery.template/docs/config.md` 的端口、双认证和本地管理说明；
- 发布包检查清单和回滚步骤。

**完成条件：**

- 新部署者可按文档完成一台 relay、一台本地后端和一个子路径前端；
- 部署文档不要求访问 node_modules 或逆向第三方实现；
- 所有秘密均通过环境变量、受保护文件或平台密钥配置，不写入模板日志；
- 文档中的路径、命令和配置键都能在仓库或发布脚本中定位。

**定向验证入口：** 配置模板语法检查、部署脚本 dry-run、文档链接和路径检查、nginx 配置测试。真实部署和浏览器操作只进入 H。

### H. 综合验证与用户验收

**目标：** 在 A-G 完成后执行自动收口、必要人工验收和用户审批。H 之前不创建最终综合验证小任务；进入 H 时必须按最新台账重建清单。

**创建时必须包含：**

1. 顶部“反馈回填槽”，登记实施中产生的所有反馈和待补项；
2. 自动验证清单，每行六列：编号、目标、命令、退出码、关键断言行、日期与产物路径；
3. 手动验证清单，每项链接 `verify/manual-final.md` 的操作卡，单项不超过 1 分钟；
4. 抽样信任记录，记录用户随机抽查自动命令退出码和断言行的结论。

**自动验证范围：**

- relay HTTP/WS 路径白名单和任意代理拒绝；
- Backend ID 列表、手动查询、在线/离线状态和会话绑定；
- rathole 配置、连接、断线、重连、撤销和非白名单端口阻断；
- 动态 HTTP/WS 端口发现及端口变更后的重连；
- loopback 管理员豁免隔离；
- Pocket ID、用户名密码同时启用、退出和会话隔离；
- 第 15 次失败冷却、递增档位、1 小时上限、challenge 绕过阻断和成功清零；
- 39980 管理器 API、启停、状态、统计和本机绑定；
- 凭据文件权限、日志脱敏和敏感响应字段；
- Electron 打包资源不含后端且主进程不 spawn 后端；
- 根路径与 `/nyxus/` 子路径的资源、API、WS、Cookie 和 OIDC URL；
- nginx 配置、Upgrade、转发头和 Cookie 行为；
- 现有普通本地 loopback 连接和旧用户名密码配置回归。

**手动验证范围：**

- Windows 托盘无控制台窗口、菜单和默认浏览器入口；
- Linux systemd 开机启动、停止、自动恢复和 CLI 输出；
- 39980 管理页面的启停、凭据复制、连接信息和 Agent 统计体验；
- 浏览器和 Electron 在本地、远程、中转之间切换；
- Pocket ID Passkey 跳转、回调、退出和重新登录；
- 后端离线、网络恢复、动态端口变更和子路径页面的真实交互。

失败时总任务退回“执行中”，登记修正小任务，修正完成后删除修正文档并从阶段一重新执行 H。

## 8. 执行顺序与并行边界

```text
A 中转协议与控制层
├─ B rathole 连接与动态下发
└─ C 后端动态端口与认证安全
    └─ D 本地管理器与运行入口
        ├─ E 前端连接发现与双登录
        └─ F Electron 前端化与子路径适配
            └─ G nginx、发布和操作文档
                └─ H 综合验证与用户验收
```

- A 必须先形成可消费的中转协议草案；B 和 C 可以分别准备适配器，但不能绕过 D1-D5；
- C 是安全关键路径，远程入口隔离方案未落定前不得实现“隧道等同本地 loopback”；
- D 依赖 C 的动态端口和认证边界，但管理器页面骨架可以提前建立；
- E 依赖 A 的列表/发现契约和 C 的登录能力契约；
- F 依赖 E 的连接抽象，不能继续从 `isElectron` 推断后端地址；
- G 只能在 B、D、E、F 的实际配置字段稳定后编写最终模板；
- H 必须最后执行，所有真实 UI、托盘、systemd 和跨设备操作集中在 H。

## 9. 计划内文件和模块影响面

这些是实施时的定位入口，不是要求一次性全部修改的文件清单。

### 后端与共享协议

- `src/service/auth/index.ts`：密码/OIDC 并存、Cookie、管理员判断和冷却；
- `src/service/index.ts`：HTTP/WS 服务装配和监听信息；
- `src/service/http/index.ts`：动态发现、远程入口、路径前缀和静态服务；
- `src/service/websocket/`：Upgrade、来源、认证和传输；
- `src/index.ts`：独立后端启动、guardian、信号和管理器托管边界；
- `src/utils/config.ts` 及认证/端口相关配置：新旧配置兼容；
- `relay/`：中转控制服务和 rathole 适配；
- `docs/shared/protocol/`：稳定的 relay、连接发现和错误契约。

### 前端与 Electron

- `web/src/services/platform.ts`：连接目标和发现结果；
- `web/src/services/ws.ts`、`web/src/services/http.ts`：动态 HTTP/WS 地址；
- `web/src/stores/auth.ts`、`web/src/services/authContext.ts`：Cookie/OIDC/密码状态；
- `web/src/features/auth/ServerLoginDialog.vue`：Backend ID、列表和双登录；
- `web/electron/main.ts`：移除后端进程生命周期；
- `web/electron/preload.ts`：移除后端配置注入；
- `web/electron-builder.yml`、相关打包脚本：移除后端资源；
- `web/vite.config.ts` 及静态资源 base 配置：子路径部署。

### 管理器、部署和文档

- 新建管理器/CLI/托盘/systemd 的源码或脚本目录，实际路径在 D 阶段确定后回写；
- nginx、rathole、relay 部署模板和发布脚本；
- `docs/backend/service/auth.md`、`docs/frontend/relay-mode.md`、`docs/guides/backend-runtime.md`、`docs/guides/relay-deployment.md`；
- `.chery.template/docs/config.md`、前后端相关 README 和质量验证入口。

## 10. 进度与恢复规则

### 当前恢复检查点

- 已完成：需求文档和本计划总入口；
- 已确认：后端独立运行、Electron 只做前端、动态端口发现、前端列表/手动 Backend ID、Pocket ID 与密码并存、本地管理器 39980、子路径部署、开放中转但只服务本协议；
- 当前小任务：H 阶段一自动收口；E-G 的代码、打包和部署资产已完成，真实托盘/systemd 操作仍归 H；
- 当前阻塞决策：D1-D8 已确认；真实公网 relay/rathole、Pocket ID、nginx 和跨设备运行仍归 H；
- 工作区约束：存在其他任务的未提交修改，不得 reset、覆盖、批量格式化或混入本任务；
- 下一步：执行 `H-verification.md` 的自动清单并回填退出码、断言行和产物；用户再按 `verify/manual-final.md` 执行真实环境卡片。真实公网 relay/rathole 联调留待 H。

### A 阶段执行记录

- `packages/protocol/src/relay.ts`、`relay/src/`、`relay/test/relay.test.ts`：设备挑战签名、首次信任绑定、租约、发现、单后端会话、路径白名单、容量/速率限制、目标适配器和脱敏审计日志。
- `docs/shared/protocol/relay.md`、`docs/relay/README.md`、`docs/shared/architecture/relay-gateway-requirements.md`：稳定契约、实现入口和已确认安全边界。
- `pnpm relay:type-check`：退出码 0；A 阶段 relay 类型无错误。
- `pnpm relay:test`：退出码 0；1 个测试文件、3 个断言用例通过，覆盖握手/发现/会话绑定、ID 冲突和限流。
- `pnpm relay:build`：退出码 0；生成 `relay/dist/index.js`。
- `pnpm type-check`：退出码 0；现有后端类型门控无新增错误。
- `git diff --check`：退出码 0；无空白错误。

### 连续实施进度（2026-09-21）

- B：已加入后端控制客户端、挑战签名、租约心跳/退避重连、动态双服务 TOML、私有配置写入、rathole 进程替换和非敏感状态摘要；`pnpm relay:type-check`、`pnpm relay:test`、`pnpm relay:build`、`pnpm manager:type-check`、`pnpm manager:build`、`pnpm type-check` 和 `git diff --check` 均退出码 0；真实 rathole server/client 联调仍待 H。
- C：已完成双认证能力发现、账号级密码失败冷却、入口级 loopback 隔离、仅 loopback 的动态远程 HTTP/WS 监听、发现响应分层、公共前缀 Cookie 和监听状态摘要；真实公网 relay/rathole 联调仍待 H。
- D：已完成 manager CLI（`info`、`status`、`restart`、`service install/uninstall`）、Linux user systemd 安装脚本、Windows 隐藏托盘启动脚本、凭据/统计/管理页面；`pnpm manager:type-check`、`pnpm manager:build`、`pnpm type-check`、`pnpm web:type-check`、`pnpm web:build`、`pnpm exec vitest run test/manager/server.test.ts`、PowerShell 脚本解析和 `git diff --check` 均通过；真实托盘/systemd 操作仍待 H。
- E：已完成本地管理器发现缓存刷新、动态 HTTP/WS 地址消费、手动远程/relay 公共路径兼容和现有双登录状态适配；按用户约束不新增 Backend ID 选择器，真实 relay 绑定与双设备流程进入 H。
- F：已删除 Electron 后端 spawn、preload 后端配置注入、后端打包资源和后端运行时准备脚本；纯前端资源扫描与生产子路径真实交互进入 H。
- G：已完成 nginx 静态前端/API/WS 模板、Windows/Linux 服务入口和运行/发布文档对齐；真实 nginx、Pocket ID、rathole 发布环境尚未运行。
- H：已建立并执行自动清单；H-A01、H-A04-H-A13（除 H-A02/H-A03）退出码 0，H-A02/H-A03 被外部未提交 `PresetsTab.vue` 类型错误阻塞；人工卡和抽样信任尚未完成。
- 自动检查：relay 3 个测试文件共 6 个测试通过，远程监听测试 4 个通过，管理器 API 测试 1 个通过；Vite 单独构建退出码 0；远程测试输出含第三方 sourcemap 缺失提示，不影响对应退出码。

### C 阶段执行记录（2026-09-21）

- `src/service/index.ts`、`src/service/http/index.ts`、`src/service/websocket/index.ts`：增加仅绑定 `127.0.0.1` 的远程 HTTP/WS 监听、动态端口 `ready` 结果和本地/远程发现分层。
- `src/service/auth/index.ts`：增加入口级 loopback 策略、共享认证状态和远程 Cookie 公共前缀处理。
- `src/worker.ts`、`manager/src/server.ts`、`.chery.template/config.yaml`：增加远程监听配置和不含秘密的实际端口状态摘要。
- `docs/shared/protocol/websocket.md`、`docs/backend/service/README.md`、`docs/backend/service/http.md`、`docs/backend/service/websocket.md`：同步 C 的发现、监听和认证边界。
- `test/service/remoteListener.test.ts`：HTTP/WS 远程认证、动态发现字段、本地 loopback 兼容和账号冷却共 4 个用例通过。
- `pnpm type-check`：退出码 0。
- `pnpm manager:type-check`：退出码 0。
- `pnpm vitest run test/service/remoteListener.test.ts`：退出码 0；1 个测试文件、4 个用例通过。
- `pnpm build`：退出码 0；既有 Windows `EBUSY` 原生文件锁提示不影响构建完成。
- `pnpm manager:build`：退出码 0；生成 `manager/dist/index.js`。
- `pnpm plan:lint`：退出码 0；计划入口和链接检查通过。
- `pnpm exec prettier --check ...`：退出码 0；本轮涉及源文件格式通过。
- `git diff --check`：退出码 0；无空白错误。

### 每个小任务开始前

1. 从 `docs/plan/README.md` 进入本 README；
2. 复核本台账中的状态、复杂度、依赖和恢复检查点；
3. 向用户说明该小任务复杂度和需要的能力特征，并等待具体 Agent/模型确认；
4. 创建或更新该小任务的独立 `.md`，只记录当前未完成工作；
5. 先读取该模块权威文档和验证基线，再修改代码或持久文档。

### 小任务完成时

按计划规范依次执行：

1. 记录变更对象、自动命令、退出码、关键断言行和产物路径；
2. 将台账状态改为“已完成”，移除该小任务链接；
3. 把长期契约、操作方式和测试迁入权威文档/正式测试；
4. 删除已完成的小任务文档；
5. 更新本恢复检查点和 H 的待验证范围。

## 11. 最终计划收口

本计划采用项目配置规定的显式用户审批流程：

1. A-G 全部完成并删除独立小任务文档后，创建 H 并将总任务状态改为“待综合验证”；
2. H 阶段一自动清单全部执行，反馈回填槽清零；
3. H 阶段二由用户按 `verify/manual-final.md` 完成人工操作卡；
4. 登记用户对自动清单的抽样信任结论；
5. 通过后将总任务改为“待用户审批”，向用户报告结果；
6. 用户明确批准后，把长期验收证据迁入 `docs/quality/verification/relay-gateway/`；
7. 删除 H、总任务目录和 `docs/plan/README.md` 中的任务行，不保留已完成计划残件。

计划完成前，`docs/plan/relay-gateway/` 是跨会话恢复入口；计划完成后，稳定契约、部署操作和验收证据必须已经迁入各自权威位置。

## 12. 用户审批

- 需求方向：用户已确认；
- 本实现计划：用户已确认，A 阶段进行中；
- 最终交付：必须经过自动验证、必要人工验收和用户明确批准。
