# NapCat 身份来源与 selfId 验证

**状态：** 现行只读审计结论

**事实所有者：** 本文负责 NapCat 侧身份来源的可信等级、验证规则和诊断边界；插件消息字段与握手流程仍以 [QQ 插件协议](./qqbot-plugin.md) 为准。

## 结论

当前可用于产生运行时 selfId 的唯一合格来源，是 NapCat 原生插件通过受限 Action 调用取得的两份一致状态：

1. `get_login_info({})` 返回合法 `user_id`。
2. `get_status({})` 同时返回 `online === true` 和 `good === true`。

两次调用都通过 NapCat 的 `ctx.actions.call(name, params, adapterName, pluginManager.config)`，因此不是普通日志、WebUI 文本或未验证连接自报。插件只有在两项都成功后才启动后端连接；任一项失败都停在 `identity-unavailable`。

- 当前 NapCat 技术插件 ID为 `napcat-plugin-cherynyxus`，用户可见名称为 `NapCat Plugin Chery Nyxus`。宿主持久化目录中的安装包与 `platform/napcat-plugin/dist/index.mjs` 的 SHA-256 一致（审计时值未写入业务日志）。宿主 `plugins.json`、允许列表、路由和部署目录必须使用同一兼容 ID；目录名和内部 ID不一致不能单独证明身份来源。

## 来源优先级和明确排除

| 优先级 | 候选来源 | 验证方法 | 结论 |
| --- | --- | --- | --- |
| 1 | NapCat 原生 Action `get_login_info` + `get_status` | 通过受限 Action 入口调用；校验合法 `user_id`、`online`、`good`，再允许握手 | 唯一可产生运行时 selfId 的来源 |
| 2 | 后端 `qq.plugin.hello` 响应 | 校验协议版本、响应 selfId 与已发现 selfId 相同、`authenticated === true`、后端版本和完整能力集合 | 这是后端通道认证，不是 selfId 的独立来源；失败时不得继续消费事件 |
| 3 | 插件目录、包名、版本、构建物一致性 | 固定路径、内部 ID、包元数据和构建哈希核对 | 仅证明安装对象/版本归属，不能产生 selfId |
| 4 | 宿主启用配置与容器挂载 | `plugins.json` 启用项、`napcat` 容器挂载到 `/app/napcat/plugins` 的持久目录核对 | 仅证明插件被启用和文件可见，不能证明已登录 |
| 5 | NapCat WebUI 人工显示 | 可作为启动前人工前置观察 | 不能作为程序内身份来源或自动认证结果 |

以下内容明确不可信：首次 `hello` 请求、连接端自报的 `selfId`、普通日志（包括扫描二维码、插件 loaded/initialized、登录错误等）、迁移记录中的旧 selfId、包名或目录名单独出现、WebUI 文本单独出现。后端 `qqbot.config.loaded` 也只是旧配置通知，不能作为能力证据。

## selfId 格式与一致性

插件内部 `qqId()` 将数字或字符串转为十进制字符串，并只接受正整数、最多 20 位：`^[1-9]\d{0,19}$`。数字必须是安全整数且大于 0；超出安全整数范围、0、负数、空字符串、带符号/小数/空白/其他字符均拒绝。协议层 `QQIdSchema` 使用相同的字符串规则。

发现后，以下值必须保持完全一致：

- `get_login_info.user_id` 规范化后的 selfId；
- 插件发送的 `qq.plugin.hello.params.selfId`；
- 后端响应的 `qq.plugin.hello.data.selfId`；
- 事件 `self_id` 规范化后的值；
- 后端通知和恢复数据中的 `selfId`。

不做前导零归一化以外的“修复”，不把历史记录、日志或客户端自报值拿来覆盖 Action 结果。消息事件还必须满足 `event.self_id === 已发现 selfId`，发送者不能等于 selfId，且 sender/user 字段要一致。

插件状态接口同时返回脱敏的 `identity` 对象，用于审计发现结果而不暴露账号内容：`state` 为 `discovered` 或 `unavailable`，`sourceType` 为 `napcat-action` 或 `none`，`validation` 为 `accepted` 或 `rejected`，`diagnostic` 仅使用 `none`、`action-error`、`source-missing`、`invalid-self-id`、`offline` 等稳定类别。状态接口不返回 selfId、Action 原始响应、连接内容或错误对象；握手失败仍单独报告为 `backend-unsupported`，不会改写身份发现结果。

## 状态、缺失、冲突和异常契约

| 情况 | 结果 | 可记录诊断（脱敏） |
| --- | --- | --- |
| Action 缺失、超时、返回结构不完整或 selfId 格式非法 | `identity-unavailable`；不启动后端连接、不消费消息 | `identity-unavailable`、Action 名称、结构化失败类别 |
| `online !== true` 或 `good !== true` | 同上 | 仅记录状态类别，不记录完整响应 |
| hello 响应缺字段、版本/能力不匹配或 selfId 不一致 | `backend-unsupported`；不进入 ready，不消费消息 | `backend-unsupported`、协议/能力/身份不匹配类别 |
| 事件 selfId、sender 或目标字段不一致/格式异常 | 丢弃该事件，不提交后端 | `input-rejected` 或稳定拒绝类别 |
| 多个可信来源给出不同 selfId | 拒绝继续，不能选择其一；保持未 ready | 状态 `backend-unsupported`，只记录状态名；身份发现结果保持已发现不被改写，无独立冲突诊断类别 |
| 日志/状态只能证明 loaded、扫描二维码、普通运行 | 不生成 identity success | 可记录普通生命周期类别，不记录正文 |
| 持久化 delivery journal 损坏或超限 | `journal-invalid` / `journal-full`；停止消费 | 状态名和计数类别，不记录消息或凭据 |
| 后端 HTTP 401、暂停环境或握手失败 | 记录为后端通道失败，不改写已发现 selfId | `backend-unsupported` 或认证失败类别；不把 401 当身份成功 |

所有失败都 fail closed：不得回退到旧 OneBot socket、普通 Chat RPC、relay、日志猜测或连接自报。日志只允许出现状态名、来源类别、协议版本、能力名称、requestId/eventId、目标类型、时间等非秘密信息；禁止 token、凭据、Cookie、完整消息、昵称、完整连接内容和完整身份诊断响应。

## 已核对的现状和限制

- 容器为 `napcat-cherynyxus:local`，持久化挂载包含 NapCat 配置和 plugins 目录；当前插件目录只看到 `index.mjs` 与 `package.json`，权限为目录 0755、文件 0644。
- `plugins.json`、加载器允许列表和宿主插件目录统一使用兼容技术 ID `napcat-plugin-cherynyxus`；用户可见名称为 `NapCat Plugin Chery Nyxus`，逻辑职责名称为 `cheryNyxus-qq-adapter-napcat`。
- `onebot11` 配置仍有独立 WebSocket server 配置，但现行原生插件代码不建立 OneBot socket；不能把该配置或其日志作为新插件身份证明。
- 只读运行检查得到过一次受限 Action 成功的 selfId 与在线状态（本文不保存完整账号号）；这证明 Action 入口在当次检查可用，不证明后端 hello 认证成功。
- 当前后端运行曾以 `QQ_INGRESS_PAUSED=1` 和无凭据测试环境返回 HTTP 401；这只能作为暂停环境的通道拒绝证据，不能伪造 `authenticated/version/capabilities`。
- NapCat 日志曾出现二维码扫描等待、插件加载成功以及周期性登录错误；这些均被排除为身份来源。真实 QQ、跨容器后端握手和业务消费仍需单独验收。

## 代码和测试入口

- 身份发现与状态转换：[`platform/napcat-plugin/src/adapter.ts`](../../../platform/napcat-plugin/src/adapter.ts) 的 `Adapter.start()`、`Adapter.action()`、`qqId()`。
- 连接握手与能力校验：同文件 `Adapter.startInternal()`；传输边界：[`platform/napcat-plugin/src/wire.ts`](../../../platform/napcat-plugin/src/wire.ts) 的 `BackendChannel` 与 `BackendWire`。
- 事件身份校验：同文件 `normalize()`；共享协议 ID：[`packages/protocol/src/qq.ts`](../../../packages/protocol/src/qq.ts) 的 `QQIdSchema`。
- 原生插件入口和失败脱敏：[`platform/napcat-plugin/src/index.ts`](../../../platform/napcat-plugin/src/index.ts) 的 `plugin_init()`、`plugin_onmessage()`、`plugin_status()`。
- 现有定向测试：[`qqPluginWire.test.ts`](../../../apps/backend/test/service/qqPluginWire.test.ts) 覆盖 Action 四参数调用、成功身份发现、握手缺失/能力不匹配、断线隔离、事件身份伪造拒绝和损坏状态隔离；运行 `pnpm --dir platform/napcat-plugin typecheck && pnpm --dir platform/napcat-plugin build && pnpm qq-ingress:test`。
- 后端协议和真实边界：[`qqbot-plugin.md`](./qqbot-plugin.md)；自动化不得连接真实 QQ 或真实模型，真实 QQ、跨主机连接和人工 WebUI 观察由用户验收。
