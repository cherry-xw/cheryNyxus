# Message Adapter（响应归一与消息构建）

> 源码 [src/core/message/adapter.ts](../../src/core/message/adapter.ts) ｜ 上级 [core/README.md](./README.md) ｜ 相关 [llm.md](./llm.md)、[sense.md](./sense.md)

## 职责

把**各 provider 原生响应/流式 chunk** 翻译成框架统一的 `LLMResponse` 结构，并反向把历史 `LLMResponse[]` 构建为 provider 期望的消息数组。它是 LLM 调用链上的「格式适配层」：[`LLMAdapter`](./llm.md) 吐原生对象，[`SenseAdapter`](./sense.md) 提取工具调用，MessageAdapter 负责其余文本字段（role / content / thinking）的统一。

`LLMResponse` 是整个框架的**通用对话货币**：`MiddlewareContext.soul.messages`、`db/chat.ts` 持久化、`service/chat/observer.ts` 落库、web 回显，全都以它为元素类型。

## 文件清单

| 文件 | 职责 |
|------|------|
| [adapter.ts](../../src/core/message/adapter.ts) | `Role`、`SenseCallInfo`、`ReplaceInfo`、`LLMResponse`、`MessageProviderAdapterConfig`、注册表三件套 |

> ⚠ 真实代码**没有** `src/core/message/index.ts`；整个 message 子模块就一个 `adapter.ts`。

## 核心概念 / 导出

### Role

```ts
type Role = "system" | "user" | "assistant" | "sense" | "function" | "role" | "subagent";
```

框架实际持久化的 role 是前四个（`function` 仅为兼容保留）。`sense` 角色专指「感官执行结果」消息，与 assistant 的 tool_calls 配对（OpenAI tool 协议要求 assistant(tool_calls) + tool(result) 成对出现）。`role`=子 pet（被 spawn 的角色）回复；`subagent` 仅旧历史消息兼容（与 `role` 等价），见 [agent-pet.md](../agent-pet.md) §5.4。

### LLMResponse（统一响应结构）

```ts
export interface LLMResponse {
  id: string;
  role: Role;
  content: string;
  thinking?: string;
  senseCalls?: SenseCallInfo[];   // assistant 发起的感官调用
  createdAt: number;
  updateAt: number;
  hash?: string;                  // 感官执行结果 hash（仅 sense 消息），用于历史去重
  replace?: ReplaceInfo;          // 该 sense 消息被后续相同 hash 调用替换
  originalContent?: string;       // 被替换时保留原内容（溯源/前端折叠显示）
  revoked?: boolean;              // chat.send 撤回标记，buildMessages 时过滤
}
```

- **`revoked`**：由 [`Middleware.revokeTrailingCycle`](./middleware.md) 在 `chat.send` 恢复场景打标，`buildMessages` 构建给 LLM 的上下文时过滤掉。详见 [interaction.md](../interaction.md)。
- **`hash` + `replace`**：感官执行结果按内容算 hash；若新读取命中历史相同 hash（文件未变动），旧 sense 消息被替换为短说明，长内容移到 `originalContent`。去重逻辑在 [`agent/middleware/tool.ts`](../../src/agent/middleware/tool.ts) `doExecuteSense`。

### SenseCallInfo

```ts
export interface SenseCallInfo {
  id: string;
  name: string;
  arguments: string;   // JSON 字符串
}
```

### ReplaceInfo

```ts
export interface ReplaceInfo {
  state: boolean;   // 是否被替换
  by: string;       // 替换者的 sense call id
  content: string;  // 替换后的短说明
}
```

### MessageProviderAdapterConfig

provider 实现这组函数交给框架，框架据此做归一。泛型 `T`=完整响应、`TStream`=流式 chunk、`TMessage`=provider 消息类型。

```ts
export type MessageProviderAdapterConfig<T, TStream = unknown, TMessage = unknown> = {
  content: (raw: T) => string;                                       // 完整响应正文
  thinking?: (raw: T) => string | undefined;                         // 完整响应思考
  extractStreamDelta: (chunk: TStream) => string;                    // 正文流式增量
  extractStreamThinking?: (chunk: TStream) => string | undefined;    // 思考流式增量
  buildMessages: (history: LLMResponse[], attachments?: LLMAttachment[]) => TMessage[];  // 反向构建（含多模态附件）
};
```

> 注意：**role 不由此 adapter 提供**——role 来自 `LLMResponse.role`（构建时已知），无需从原生响应反解。**senseCall 提取不在此处**——流式走 [`SenseAdapter.extractSenseCallDeltas`](./sense.md)，完整提取走 `SenseAdapter.senseCalls`。MessageAdapter 只管 `content` / `thinking` 的流式 delta 与完整响应字段，以及反向 `buildMessages`。

### LLMAttachment（多模态附件）

`buildMessages` 第二参 `attachments?` 为多模态附件，**临时参数，不进 `LLMResponse`/DB**：

```ts
export interface LLMAttachment {
  mimeType: string;     // 如 "image/png" / "video/mp4" / "audio/wav"
  data: Buffer;         // base64 前的二进制
  kind?: MediaKind;     // "image" | "video" | "audio"，供 provider 区分 content part 格式
}
```

由 [`chatMiddleware`](../../src/agent/middleware/chat.ts) `enrichMediaInputs` 据脑 `capabilities.input` + 消息正文里的 `[[media:<filename>]]` marker 现场构造（`readMediaAsset` 同步读 base64），provider 调用后丢弃。provider 据 `mimeType`/`kind` 决定 content part 格式（如 OpenAI 兼容端点：image→`image_url`、video→`video_url`、audio→`input_audio`）。多模态是否走原生旁路由 `chatMiddleware` 据 `capabilities.input` gate，见 [model-capabilities.md](../model-capabilities.md)。

### 注册表

```ts
registerMessageAdapter<T, TStream, TMessage>(provider, adapter): void
getMessageAdapter(provider): MessageProviderAdapterConfig | undefined
resetMessageProviders(): void   // 测试 / 热更清残留
```

## 关键流程 / 数据流

```text
─── 流式响应归一（chatMiddleware 内） ───────────────────────────
原生 chunk  ──► messageAdapter.extractStreamDelta(chunk)   ──► contentDelta
            ──► messageAdapter.extractStreamThinking(chunk)──► thinkingDelta
            ──► senseAdapter.extractSenseCallDeltas(chunk) ──► senseDelta
           三者组装为 StreamChunk，向上游 checkpoint 归纳

─── 完整响应归一（loop 收尾 / 非流式 chat） ────────────────────
原生 response ──► messageAdapter.{role,content,thinking}(response)
               ──► senseAdapter.senseCalls(response)  → SenseCallInfo[]
            → 组装 LLMResponse 推入 ctx.soul.messages

─── 反向构建（每次调 LLM 前） ──────────────────────────────────
ctx.soul.messages: LLMResponse[]
  ──► messageAdapter.buildMessages(history)  ──► provider 消息格式
  ──► LLMAdapter.chatStream(messages, senses, options)
```

## 依赖与关联

- **依赖**：无（纯类型与函数，不引用其他 core 子模块）。
- **被依赖**：
  - [`agent/provider/{openai,ollama,mock}.ts`](../../src/agent/provider/) —— 实现并 `registerMessageAdapter`。
  - [`agent/middleware/chat.ts`](../../src/agent/middleware/chat.ts) —— 运行期调 `extractStreamDelta` / `buildMessages`。
  - [`agent/middleware/checkpointState.ts`](../../src/agent/middleware/checkpointState.ts) —— 用 `LLMResponse` 聚合状态。
  - [`agent/middleware/tool.ts`](../../src/agent/middleware/tool.ts) —— 用 `ReplaceInfo` 做 sense 历史替换。
  - [`agent/builder.ts`](../../src/agent/builder.ts) —— 初始 system 消息构造为 `LLMResponse`。
  - [`agent/runtimeResolver.ts`](../../src/agent/runtimeResolver.ts) —— 取 `getMessageAdapter`。
  - [`service/chat/observer.ts`](../../src/service/chat/observer.ts)、[`service/chat/runtime.ts`](../../src/service/chat/runtime.ts) —— 用 `LLMResponse` 落库 / 回显。
  - [`db/chat.ts`](../../src/db/chat.ts) —— `LLMResponse` ↔ DB 行互转。
- **横切参考**：[llm.md](./llm.md)（上游）、[sense.md](./sense.md)（senseCalls 协同）、[db.md](../db.md)（`revoked` / `replace` 字段的持久化列）。

## 扩展点

见 [llm.md「扩展点」](./llm.md#扩展点接新-provider)：MessageAdapter 与 LLMAdapter、SenseAdapter 成套实现、一并注册。
