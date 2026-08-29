# 错误信息分层规范（Error Conventions）

> 横切规范：所有面向用户的错误提示（前端 toast/banner、WS 错误帧、HTTP 错误响应、provider/middleware 抛错、控制台 warn）都应遵循此约定。
>
> **Why**：用户看到的应是"直观表达问题 + 来源"的人话，不是机读 ID 或技术栈；开发者排查则需要完整上下文。两者各居其位，**互不污染**。
>
> **How to apply**：抛错前调 `throwUserFacing(scope, userMessage, context)`，message 自动**前置** `tracingId`，详细上下文走 `logger.event` 落盘。

## 核心原则：用户面 vs 日志面分离

错误信息**分两层**展示：

| 层级                             | 形态                                             | 用途                                  |
| -------------------------------- | ------------------------------------------------ | ------------------------------------- |
| **用户面**（throw / 推送给前端） | `[tracingId] 带来源的直观中文`，1 行，**码前置** | 用户直观理解问题 + 开发者凭码查日志   |
| **日志面**（`logger.event`）     | 结构化 JSON 事件，含完整上下文                   | 开发者凭 `tracingId` 全文检索日志还原 |

## 用户面规则

1. **中文**（项目 [规范](../.claude/CLAUDE.md)）
2. **一行**（不堆栈、不 trace、不内嵌多行）
3. **抽象直观表达问题**——用 Brain（大脑/AI服务）/Sense（感官/工具）/Chat 隐喻；**通用兜底必须带来源名词**（`脑子`/`感官`/`媒体`/`扩展工具`/`会话`/`系统`），禁止裸"出了点小问题"。不写"反馈给开发"话术——使用端不考虑开发问题，所有错误导向"去改设置"。
4. **`tracingId` 前置** `[xxxxxxxx]`——8 位 hex（UUID 前 8 位）放消息**开头**（非末尾），便于日志肉眼追踪定位来源
5. 抛错点若已知分类与来源，用 `ClassifiedError`（见下）携带——[retry 中间件](./agent/middleware.md) 据此判重试；否则表层出口按 `classifyError` 关键词兜底分类
6. **message 一行内不暴露后端机读字段**（OpenAI `request id`、HTTP `status`、栈帧）——技术细节走 **detail 通道**（见下节）或日志，不进 `message` 本体

## 日志面规则

1. **类型**：`logger.event("<scope>", { ... }, LogLevel.error)`；scope 用模块前缀（`llm.*` / `sense.*` / `mcp.*` / `compose.*` / `app.*`）
2. **必含字段**：
   - `tracingId`：8 位 hex
   - `error`：完整 message
   - 1~3 个上下文锚定字段（`model` / `senseName` / `component` / `chatId`）
3. **扩展字段**：`reason`（细分原因枚举，如 `placeholder_unresolved` / `key_empty` / `network_refused`）、`url` / `envName` / `attempt` 等自由扩展
4. **栈**：`cause` 链由 Error.cause 传递，不在 data 里重复

## 错误详情通道（detail）

**背景**：message 一行 + 友好文案的分离策略，在「确定性配置错误反复失败」场景下体验失效——用户只看到「脑子出了点状况，稍后再试」，不知道 upstream 具体拒绝了什么（status、body 摘要），也没有可操作的自查方向；tracingId 虽在 message 里，但用户不知道它怎么用。

**约定**：`ClassifiedError` 与流式错误通知增加可选 **`detail` 字段**，作为用户面与日志面之间的中间层：

| 层级              | 位置                                                                            | 内容约束                                                                                                        |
| ----------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `message`（已有） | error 通知 data / toast                                                         | 一行友好文案 + `[tracingId]` 前缀，规则不变                                                                     |
| `detail`（新增）  | error 通知 data；前端反馈卡的“查看详情”区域（聊天界面 run 错误条目 + pet 气泡） | 上游技术摘要：`upstream ${status}: ${body前200字符}`；一行内，可含机读片段（request id 等），**不换行、不含栈** |
| 日志面（已有）    | `logger.event`                                                                  | 完整上下文                                                                                                      |

规则：

1. **哪些错误必须带 detail**：`brainHttpError`（非 2xx）、`brainInvalidStream`（伪 200）、`brainNetworkError`（网络失败）——即 source=brain 的全部确定性错误。sense/mcp 抛错后续按需补齐。
2. **`retryable` 语义收紧**：4xx（含 400/404/422）类错误 `category` 不得归类为 `provider`（不可重试的错误不要显示"稍后再试"）；`retryable=false` 仅约束**文案**（不写"稍后再试"），**不再隐藏「继续运行」按钮**——按钮显隐由服务端 error 通知的 `canResume`（`computeCanResume` 权威判定，统一暂停语义）决定，前端原样尊重。理由：validation 错误既可能是配置问题也可能是框架瞬时缺陷（如历史组装不一致），堵死恢复入口会形成"报错 + 无出路"死局。
3. **文案携带检索指引**：对 `validation` / `provider` 类错误，message 末尾追加「详情见日志，检索 [tracingId]」提示（一行内），让 tracingId 可被发现。
4. **空上下文守卫错误**：历史加载异常导致无 user 内容的请求在 chat middleware 层拦截（防御性兜底，见 [context-epochs.md 历史连续性与兼容投影](./context-epochs.md#历史连续性与兼容投影)），`category='validation'`、`source='chat'`，message 指向「重新发送」，不进入 retry。

## 反例 vs 正例

| 形态    | 例子                                                                                                                                                                             | 评价                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| ❌ 反例 | `内部错误，请用 [ecb4595a] 反馈给开发`                                                                                                                                           | 兜底临床文案 + "反馈给开发"话术错位，使用端不应见开发问题         |
| ❌ 反例 | `[compose] handler at index 3 threw: 401 Invalid token (request id: ...)`                                                                                                        | 技术层细节、不可读、机读 ID 暴露、无修复指引                      |
| ❌ 反例 | `Error: connect ECONNREFUSED 127.0.0.1:11411`                                                                                                                                    | 英文栈、用户不可操作                                              |
| ❌ 反例 | `请求失败: fetch failed` / `上游返回 401: ...`                                                                                                                                   | 临床、暴露技术细节，不直观                                        |
| ✓ 正例  | `[ecb4595a] 连不上我的脑子了`                                                                                                                                                    | 隐喻直观（Brain=AI服务）+ 来源（脑子）+ 码前置                    |
| ✓ 正例  | `[7d0ff4a1] 大脑的钥匙不对，请在设置里检查 key`                                                                                                                                  | 来源 + 问题 + 指向设置                                            |
| ✓ 正例  | `[3a9f10c2] 感官出了点小问题`                                                                                                                                                    | 通用兜底带来源（感官），非裸"出了点小问题"                        |
| ✓ 正例  | message=`[4b06695b] 脑子拒绝了这个请求，请检查设置（详情见日志，检索 [4b06695b]）` + detail=`upstream 400: {"error":{"message":"invalid params, chat content is empty (2013)"}}` | 友好文案与 `retryable=false` 一致；技术细节进 detail 不进 message |

## 实施工具

### newTracingId()

```ts
import { randomUUID } from 'node:crypto'

/**
 * 8 位 hex tracingId：UUID v4 前 8 位，理论 16^8 ≈ 42 亿组合，足够全局唯一。
 */
export function newTracingId(): string {
  return randomUUID().slice(0, 8)
}
```

### 合规识别：COMPLIANT_TRACE_PATTERN

```ts
/** 用户面 message 是否已含前置 tracingId（throwUserFacing / ClassifiedError 出口产出）。 */
export const COMPLIANT_TRACE_PATTERN = /^\[[0-9a-f]{8}\] /
```

### classifyError() / friendlyMessage()

`classifyError(error)` 按关键词分类（`auth`/`network`/`provider`/`timeout`/`validation`/`unknown`），retry 与 compose 兜底共用。`friendlyMessage(category, source)` 查表返回带来源的直观文案（不含 tracingId，由出口前置）：

| category \ source | brain（脑子）                      | sense（感官）    | system（系统）     |
| ----------------- | ---------------------------------- | ---------------- | ------------------ |
| network           | 连不上我的脑子了                   | 感官连不上了     | 系统连不上了       |
| auth              | 大脑的钥匙不对，请在设置里检查 key | —                | —                  |
| timeout           | 脑子反应太慢了                     | 感官反应太慢了   | 系统等太久了       |
| provider          | 脑子忙不过来了，稍后再试           | 感官出了点状况   | 系统出了点状况     |
| validation        | 脑子没听懂这个请求                 | 感官没听懂       | 系统没听懂这个请求 |
| unknown           | 脑子出了点小问题                   | 感官出了点小问题 | 系统出了点小问题   |

### ClassifiedError

抛错点已知分类与来源时携带，供 retry 判重试、表层出口取友好文案：

```ts
export class ClassifiedError extends Error {
  readonly category: ErrorCategory;   // auth/network/provider/timeout/validation/unknown
  readonly source: ErrorSource;       // brain/sense/media/mcp/chat/system
  readonly userMessage: string;       // 友好文案（不含 tracingId，出口前置）
  constructor(opts: { message: string; userMessage: string; category: ErrorCategory; source: ErrorSource; cause?: unknown }) { ... }
}
```

retry 读 `ClassifiedError.category`（不再靠 message 关键词）；表层出口（streamMapper / compose 最外层兜底）优先用 `userMessage`，否则 `friendlyMessage(category, source)`。**注意：** compose 的 `executeChain` 对 `ClassifiedError` **原样上浮**（保留分类身份供 retry 判重试），仅未被任何中间件处理时在最外层兜底转用户面——见 [middleware.md「调整 retry 策略」](./agent/middleware.md#调整-retry-策略)。

### throwUserFacing()

```ts
/**
 * 抛用户面错误：message 短直观，tracingId **前置**，日志面含完整上下文。
 * 仅用于终态配置错误（缺 key/model 等，本就不重试）；可重试错误用 ClassifiedError。
 */
export function throwUserFacing(scope, userMessage, context = {}): never {
  const tracingId = newTracingId()
  logger.event(scope, { tracingId, ...context }, LogLevel.error)
  throw new Error(`[${tracingId}] ${userMessage}`) // 码前置
}
```

### 用法示例

```ts
// 终态配置错误（不重试）—— throwUserFacing
throwUserFacing('llm.key.missing', `${model} 缺少 key，请在设置里检查`, {
  model,
  reason: 'key_empty',
})

// 可重试错误 —— ClassifiedError（provider 捕 SDK/fetch 错误）
throw new ClassifiedError({
  message: `fetch failed: ${err.message}`, // 日志用
  userMessage: '连不上我的脑子了', // 用户面
  category: 'network',
  source: 'brain',
  cause: err,
})
```

## 用户反馈与运行结果

错误原因、运行状态、严重程度、重试能力和会话恢复能力是五个独立维度：

- `ErrorCategory`（`auth/network/provider/timeout/validation/unknown`）只用于诊断、重试策略和日志，不直接决定 UI。
- `run.outcome.status` 是运行终态的唯一权威值：`completed/paused/failed/cancelled`。
- `feedback.severity` 决定展示层级：`info/warning/error`。
- `retryable` 表示同一操作是否适合重试；`canResume` 表示会话是否能够继续。
- 新客户端先消费 `run.outcome`，再按 `runId` 忽略随后到达的兼容 `done/error`。

所有用户可见结果统一使用 `UserFeedback`：标题说明发生了什么，description 说明影响，guidance 给出下一步，actions 只携带协议定义的语义动作。追踪码和上游摘要默认折叠，不得占据首屏。

保护性限制不是错误。以循环上限为例：

- `status=paused`
- `reasonCode=RUN_LOOP_LIMIT_REACHED`
- `severity=warning`
- `retryable=false`
- `canResume=true`
- execution termination code 为 `limit_reached`，不得记录为 `error/failed`

内部断言、`AgentAbortError`、`AgentParkError`、工具拒绝和审批取消不直接转换成普通错误；仅在用户边界转换为相应的暂停、取消或就地提示。

## 适用范围

| 场景                                                                                                                       | 实施位置                                                                                                                                        | 状态     | 备注                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider 抛错（openai 无 key / 占位符）                                                                                    | [src/agent/provider/openai.ts](../src/agent/provider/openai.ts)                                                                                 | ✓ 已实施 | 详见 [agent/provider.md](./agent/provider.md)                                                                                                                                                                                                                                                                 |
| Provider 抛错（ollama / mock）                                                                                             | [src/agent/provider/](../src/agent/provider/)                                                                                                   | 审视     | ollama 不需要 key，mock 一般不抛 401；如有其他错误路径，按需                                                                                                                                                                                                                                                  |
| **brain 确定性错误 detail 通道**（brainHttpError / brainInvalidStream / brainNetworkError 补 `detail`；4xx 不归 provider） | [src/agent/provider/fetchBase.ts](../src/agent/provider/fetchBase.ts) + [src/service/chat/streamMapper.ts](../src/service/chat/streamMapper.ts) | ✓ 已实施 | 4xx（非 401/403/429）归 `validation`（retryable=false）；detail 经 retry → ErrorChunk → error 通知 data 透传（`RunErrorNotificationData.detail`）                                                                                                                                                             |
| **空上下文守卫**（buildMessages 后无 user 内容 → validation 错误）                                                         | [src/agent/middleware/chat.ts](../src/agent/middleware/chat.ts)                                                                                 | ✓ 已实施 | 见 [context-epochs.md 初始上下文重构](./context-epochs.md#初始上下文重构)                                                                                                                                                                                                                                     |
| Middleware 通用错误包装                                                                                                    | [src/core/middleware/compose.ts](../src/core/middleware/compose.ts)                                                                             | ✓ 已实施 | 合规错误（前置 tracingId）原样上浮；`ClassifiedError` **原样上浮**（保分类身份给 retry 判重试，仅最外层兜底取 `userMessage`）；其余裸抛按 `classifyError`+`friendlyMessage(category,"系统")` 重包。详细走 logger                                                                                              |
| Sense 执行错误                                                                                                             | [src/agent/middleware/](../src/agent/middleware/)                                                                                               | TODO     | sense 抛错同样要分层                                                                                                                                                                                                                                                                                          |
| WebSocket 错误帧（router 结构校验失败）                                                                                    | [src/service/message/router.ts](../src/service/message/router.ts)                                                                               | ✓ 已实施 | `safeParse` 失败（INVALID_PARAMS）：message 一行中文 + `tracingId`，完整 Zod issues（path/code/expected/received）走 `logger.event("req.invalid_params")` 落盘。handler 业务校验错误（如 `saveRawConfig`）仍各自返回中文 join 串，未走本工具                                                                  |
| HTTP 错误响应                                                                                                              | [src/service/http/](../src/service/http/)                                                                                                       | TODO     | 401/500 等响应 body 同样分层                                                                                                                                                                                                                                                                                  |
| 前端 toast / banner                                                                                                        | [web/src/](../web/src/)                                                                                                                         | ✓ 已实施 | error 通知 data.detail 消费：聊天界面 run 错误条目（AgentDialog 时间线末尾，`session.run.errorFact` 驱动）+ Pet 气泡反馈卡，detail 默认折叠在“查看详情”中；错误保留至用户下次交互（新流首 chunk / done 时清除）；「继续运行」按钮显隐尊重服务端 `canResume`，不因 `retryable=false` 隐藏；前端不重生成 detail |

## 日志检索约定

用户报 `[tracingId]` 后：

```bash
# 项目根目录
grep "1c538629" .chery/logs/

# 全局更稳（tracingId 出现于日志 JSON 事件 data 字段）
grep -r '"tracingId":"1c538629"' .chery/
```

日志格式与查询详见 [utils/logger.md](./utils/logger.md)。

## 演进原则

- **新增错误出口**（RPC handler、sense、prompt、media gateway）必须遵循本规范——不引技术栈裸抛
- **改造旧错误**：从用户最痛点开始（高频报错 + 信息丢失严重的）逐步改造
- **tracingId 全链路**：同一 chat / 同一 RPC 调用产生的多个错误应共享**同一** tracingId，便于串联整条调用链——目前 `newTracingId()` 每次独立生成，后续如需全链路可改为从 `ctx.soul.chatId` + step 派生
