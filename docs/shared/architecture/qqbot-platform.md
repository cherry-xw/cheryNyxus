# QQ 平台新架构

**状态：** QQ 业务包使用宿主 API2；真实发送与媒体的验收结论和已知限制见[QQ 模块说明](../../../plugins/qq/README.md#当前限制与验证边界)。Manager 页面及其他模块不随 QQ 业务验收自动完成。

**事实所有者：** 本文负责系统边界、组件职责、部署拓扑、配置所有权、迁移与回滚。消息线上的字段和状态以[QQ 插件协议](../protocol/qqbot-plugin.md)为准。

后端接入插件系统和QQ首包已批准实施，配置、生命周期与管理接口以[接入插件](ingress-plugins.md)为准；不是固定内置QQ模块。Manager独立负责管理认证和页面，关闭Manager不影响聊天。

## 目标

cheryNyxus 只运行一个 Backend，插件宿主在该后端进程内加载已安装的 QQPlugin，不为它创建独立服务。NapCat 内插件只做 QQ 传输；独立 Web 提供聊天页面，独立 Manager 提供管理登录和配置页面。关闭 Web 或 Manager 不停止后端聊天。运行配置、资源、记忆、队列属于 Backend；Manager 不保存 QQ 业务副本。部署操作见[运行环境迁移](../../guides/nyxus-deployment.md)。

本次是集中开发阶段的直接替换方案：旧 OneBot/relay 运行服务、旧开发启动方式和旧双轨消费路径不进入新架构。NapCat 本体不删除、不重装。迁移完成后只允许一个消息入口，不能让旧 relay 和插件同时消费同一事件。

## 组件边界

| 组件 | 负责 | 不负责 |
| --- | --- | --- |
| NapCat QQ | QQ 登录、QQ 原生连接和 NapCat 能力 | cheryNyxus 配置、模型、记忆、队列和管理认证 |
| cheryNyxus NapCat 插件 | 接收 NapCat 事件；提取 `self_id`、发送者和目标基础字段；连接后端；按后端事件发送 QQ 消息及“收到”；插件状态与实际发送回报 | 模型 Key、脑、感官组、预设、目标绑定、记忆、等待规则、模型/工具/队列/权限副本、管理登录 |
| Docker cheryNyxus 后端 | 认证、配置、资源目录、目标绑定、会话、队列、等待计时、模型和工具执行、记忆、回复拆分、失败恢复、管理 HTTP/API | QQ 登录细节、NapCat 内部事件格式的长期耦合 |

插件与后端之间使用明确的本地或容器网络 WebSocket RPC。插件认证凭据与管理登录凭据分开，插件权限最小化，支持重连、心跳、版本和能力握手。

## 目标和资源模型

后端维护三类可复用资源：

- 大脑：名称、provider、协议、URL、只写 Key、模型、上下文预算、工具能力开关，以及该模型专属的 thinking/reasoning 开关和等级。
- 感官组：名称、工具目录选择、工具模式、记忆开关。
- 核心预设：通过现有角色关系引用大脑和感官组；QQ等待、图标与会话策略保存于独立QQ插件配置，不复制核心资源。

`global.thinking` 只表示后端全局是否允许 thinking；provider/model-specific reasoning 必须保存在对应大脑/模型设置内，不能放进通用设置。

目标只绑定一个预设：`private:user:<QQ号>` 或 `group:<群号>`。目标不直接绑定大脑或感官组。私聊是独立会话和个人记忆；群共享上下文，必须 @ 后才能开始，后续接话通过请求内参与判断决定回复、等待或结束；群成员不单独建立名单。私聊名单只控制私聊，群名单只控制群。

## 请求和配置生效

1. 插件把标准化 QQ 事件提交给后端。
2. 后端验证插件身份、`self_id`、发送者、目标类型和目标权限。
3. 后端解析目标到预设，再解析大脑和感官组，创建请求快照。
4. 请求整个生命周期使用开始时快照；保存后的配置只影响下一个请求。
5. 工具调用由后端产生；每个真实工具调用按顺序发送一个对应 icon 事件，未调用不发送，未知工具使用安全回退 icon。
6. 工具 icon 和其他运行中进度消息共享按 `waitIntervalSeconds` 配置的活动计时器：实际发送运行中消息后重置，等待提示后进入下一个周期。终态发送完成后停止并清理计时器；插件只发送标准事件。
7. 回复、失败、超时和恢复都使用协议事件；插件不自行推断终态。

大脑、感官组、预设、目标绑定、等待、thinking 参数、名单和运行策略保存后更新后端运行时版本，下一个请求使用新版本，进行中的请求不切换。保存失败保留上一份可用配置并返回 `saved/applied/failed` 状态。

## 认证和安全边界

### API2 业务入口与持久数据

QQ 包入口为 [`createPlugin`](../../../plugins/qq/src/index.ts)，清单为 [`config.yaml`](../../../plugins/qq/config.yaml)。包通过宿主渠道验证器核验连接、原生绑定和已入队事件，再获取可信身份句柄；核心只验证通用授权、句柄和会话归属，不根据 QQ 包名或会话名称放行。

每条输入通过 `RequestPrepare` 注入应用中的提示词、身份和最新记忆；本次模型循环复用请求视图，不写入会话历史。记忆注入由 `memoryEnabled` 控制，与维护工具是否列入工具组无关。私聊按个人隔离，群事实由群主题存储提供；数据格式及来源验证见[QQ 模块](../../../plugins/qq/README.md#实现与使用边界)。个人文件按可信发送者共享，不扩大私人记忆范围。

[`QQMemoryStore`](../../../plugins/qq/src/memory.ts) 提供单个批量保存/删除工具，完整校验后加锁并原子写入，校验请求记忆版本，损坏文件拒绝覆盖。个人文件和路径保护由 [`files.ts`](../../../plugins/qq/src/files.ts) 负责。停用撤销业务注册、工具和 Hooks，保留配置、状态、队列和管理接口。

部署启动参数使用通用 `channelAuth`：显式提供 `credentialKind`、`header`、受限 token 和可选 `readyNotification`。QQ 通道的值由部署层注入，核心不读取 QQ 专用环境变量；QQ 暂停和个人文件目录由包读取。旧启动配置必须在受限部署任务中迁移，本实现不自动解除暂停。

当前 QQ 包只接受当前配置、队列和记忆格式，不提供旧目录导入工具。已有文件不得由运行时猜测转换或清除。

定向验证见 [`qqBusiness.test.ts`](../../../plugins/qq/test/qqBusiness.test.ts)、[`qqPluginWire.test.ts`](../../../apps/backend/test/service/qqPluginWire.test.ts) 和 [`qqProcessRestart.test.ts`](../../../apps/backend/test/service/qqProcessRestart.test.ts)。进程恢复测试先用 `pnpm exec vite build --config apps/backend/test/service/fixtures/qqRestart.vite.config.ts` 构建独立 worker；这些验证只证明离线行为，不证明真实 QQ 发送或部署完成。

管理页面使用服务端 Session Cookie：HttpOnly、SameSite、Secure；支持基础登录、用户名密码和 Pocket ID OIDC。OIDC 使用 Authorization Code + PKCE、state、nonce、issuer/audience 校验；OIDC subject 必须绑定或命中管理员白名单。浏览器不保存密码或 OIDC token。

插件连接凭据与管理 Session 完全分离。后端必须检查插件身份、版本、能力、`self_id`、事件发送者和目标边界；校验 Origin/Host、CSRF、重放、重复消息和协议版本。Key、密码、Session、PII 不进入日志、错误、事件或状态页面。

## Docker 拓扑

默认部署中 Manager 与 Backend 配套运行于同一镜像，先启动 Manager 再由它启动 Backend；Web 可独立部署并反代 Backend 的 HTTP/WS。配套容器使用可出站网络，显式发布所需端口，不挂 Docker socket；Manager 管理自身 Backend 子进程，资源操作仍通过认证接口。显式 external 模式不启动第二个 Backend。数据持久化和迁移回滚操作由[运行环境迁移](../../guides/nyxus-deployment.md)维护；NapCat 本体部署保持独立。

开发环境和常驻 Docker 是同一新架构的两种启动方式：开发环境允许本机进程和 mock/wire；常驻环境使用 Docker 和持久卷。二者都禁止恢复旧 relay 作为运行层。

## 迁移、回滚和交付记录

迁移前停止并禁用旧 OneBot/relay 消费者，确认 NapCat 仍运行；启动后端，再连接插件；用合成事件完成单入口、重复投递和恢复检查。迁移期间不让旧 relay 与插件同时接收事件。

回滚只能回到迁移前已停止的旧服务快照，且必须先停止插件并清理其连接状态，防止双消费。回滚不删除 NapCat 登录数据，不把新后端配置秘密复制到旧服务。

每次交付必须列出：需要重启的服务、已重启并验证的服务、当前可用地址/功能、未验证项目。没有真实 QQ、真实模型、跨主机页面或视觉验收证据时，明确写未验证。

## 验收门槛

自动化必须用 mock/wire、合成目标和合成资源，不能调用真实模型或发送真实 QQ。至少证明：

- 插件是唯一消息入口，事件接收和文本字段准确；
- 工具 icon 的数量和调用顺序准确；
- 首次/后续等待间隔由后端控制；
- thinking 全局字段与模型专属 reasoning 字段归属正确；
- 每个目标严格 1:1 绑定预设；
- 热应用快照、失败保留、重连和 Docker 持久卷恢复有效；
- 工具 icon 后计时器重置、无运行中消息才等待、等待后继续周期、终态关闭计时器，并且重连/重放不重复发送；
- local/OIDC 登录最终都得到服务端 Session；
- 旧 relay 不再运行。

真实 QQ、跨主机访问、页面视觉和主观交互由用户最后验收，不能由构建或单元测试代替。
