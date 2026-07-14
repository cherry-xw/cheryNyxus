# LLM Adapter（模型调用契约）

> 源码 [src/core/llm/adapter.ts](../../src/core/llm/adapter.ts) ｜ 上级 [core/README.md](./README.md) ｜ 相关 [message.md](./message.md)、[sense.md](./sense.md)

## 职责

定义「调用一个大模型」的最小契约：给定消息序列、可用感官（工具）、模型选项，返回**完整响应**或**流式 chunk 异步迭代器**。core 只给接口和注册表，真正的 HTTP/SDK 调用在 [`agent/provider/`](../../src/agent/provider/) 里实现（openai / ollama / mock 三套）。

注意：此文件**不关心响应内容的解析**——它吐出 provider 原生响应对象（`TResponse` / `TStreamChunk`），由 [`MessageAdapter`](./message.md) 负责把原生响应归一为 `LLMResponse`、由 [`SenseAdapter`](./sense.md) 提取 senseCalls。

## 文件清单

| 文件 | 职责 |
|------|------|
| [adapter.ts](../../src/core/llm/adapter.ts) | `LLMOptions`、`LLMAdapter` 接口、`registerLLMAdapter` / `getLLMAdapter` / `resetLLMAdapters` 注册表 |

> ⚠ 真实代码**没有** `src/core/llm/index.ts`（CLAUDE.md 旧描述与源码不符）；整个 llm 子模块就一个 `adapter.ts`。

## 核心概念 / 导出

### LLMOptions

调用选项，provider 按需读取。`model` 必选，其余可选。

```ts
export interface LLMOptions {
  model: string;
  url?: string;
  key?: string;
  thinking?: ThinkingLevel; // 思考强度档位（见下），off=不发该参数，其余按 provider 映射
  rpm?: number;             // 每分钟最大请求数，provider 层滑动窗口限流，未配置则不限流
}

/** 思考强度档位。off=关闭（provider 省略思考参数）；on=由模型决定（provider 不传参）；low/medium/high=强度递增，各 provider 自行映射为请求参数。 */
export type ThinkingLevel = "off" | "on" | "low" | "medium" | "high";
```

### ThinkingLevel 全链路与 global 总闸

`thinking` 从纯 boolean 升级为 5 档枚举（含 `on`「由模型决定」），全链路：

```text
config.yaml brain.<name>.thinking (ThinkingLevel)
  └─ loadConfig / readRawConfig 归一化（legacy boolean 兼容：true→"high"、false/缺省→"off"）
     → ctx.runtime.brain.thinking (ThinkingLevel)
        └─ chatMiddleware 构造 LLMOptions.thinking（与 global.thinking 做 AND 闸，见下）
           → provider 内 mapThinkingToReasoningEffort 等映射 → 请求参数
```

**模型级档位（settings 渲染用）**：不同模型支持的档位不同。`.chery/model-thinking.yaml` 声明模型别名 → 档位子集的映射；前端 BrainCard 经 `utils.thinkingLevels` RPC 查询当前 model 的可选档位，渲染「深度思考」旋钮。未配置或未命中 → 兜底 `["off", "on"]`。详见 [../utils/README.md#modelThinking.ts — 模型档位映射](../utils/README.md)。

**global.thinking AND 闸**：`config.yaml` 另有 `global.thinking: boolean`（全局总开关）。`chatMiddleware` 构造 `LLMOptions.thinking` 时做 AND：`global.thinking` 为 false 时强制 `"off"`，为 true 时取 `brain.thinking`。即全局开关关闭则一律不思考，开启后强度由各 brain 自定。

**provider 映射约定**：每个 provider 自行把 `ThinkingLevel` 翻译成厂商参数（详见 [provider.md](../agent/provider.md)「ThinkingLevel→参数映射」）：

- `off` → 省略该参数（绝对安全，非推理模型也不会报错）。
- `on` → 不传参，**由模型/服务端自行决定**是否思考（适合 ollama 等不接 `reasoning_effort` 的 provider，或未声明档位的模型）。
- `low/medium/high` → 厂商对应字段：OpenAI 兼容端点（含智谱 bigmodel、聚合端点）用 `reasoning_effort: <level>`；ollama 不传（由服务端/模型决定）；未来 anthropic 用 thinking block。

> ⚠ `reasoning_effort` 等思考参数仅对**推理模型**有效，非推理模型（如 gpt-4o）会返回 400；`off` 档省略参数无此风险。brain 配置时按模型类型选择。

### LLMAdapter 接口

泛型默认 `unknown`，provider 实现时可强化为自己的消息/响应/chunk 类型（如 OpenAI 用 `ChatCompletionMessageParam[]`）。

```ts
export interface LLMAdapter<
  TMessages = unknown[],
  TResponse = unknown,
  TStreamChunk = unknown,
> {
  chat(
    messages: TMessages,
    senses: SenseFunction[],          // 来自 SenseAdapter.buildSenses，见 sense.md
    options?: LLMOptions,
  ): Promise<TResponse>;

  chatStream(
    messages: TMessages,
    senses: SenseFunction[],
    options?: LLMOptions,
  ): Promise<AsyncIterable<TStreamChunk>>;
}
```

- `chat`：非流式一次性返回完整响应。
- `chatStream`：返回流式 chunk 的 `AsyncIterable`，由上层中间件（`chatMiddleware`）逐 chunk `yield` 给 checkpoint 归纳。

`senses: SenseFunction[]` 是已经 provider-格式化好的工具声明（由 [`SenseAdapter.buildSenses`](./sense.md) 产出的 `SenseFunction` 数组直接透传），LLMAdapter 只负责塞进 provider 的请求体。

### 注册表（全局 Map）

```ts
registerLLMAdapter(name: string, adapter: LLMAdapter): void   // 注册
getLLMAdapter(provider: string): LLMAdapter | undefined      // 按 brain.provider 取
resetLLMAdapters(): void                                      // 测试 / 热更清残留
```

注册名约定为 provider 字符串（`"openai"` / `"ollama"` / `"mock"`），与 `config.yaml` 中 `llm.brain.<name>.provider` 字段对齐。

## 关键流程 / 数据流

```text
AgentBuilder.configureRuntime(selection)
  └─ RuntimeResolver 按 brain.provider 调 getLLMAdapter(provider)
     → 得到 LLMAdapter 实例，塞进 RuntimeConfig.adapters.llmAdapter
        ↓ Middleware 运行期
  chatMiddleware（agent/middleware/chat.ts）
  ├─ ctx.runtime.adapters.messageAdapter.buildMessages(history) → provider 消息格式
  ├─ ctx.runtime.adapters.senseAdapter.buildSenses(...)         → SenseFunction[]
  └─ llmAdapter.chatStream(messages, senses, LLMOptions)        → AsyncIterable<chunk>
       │  （LLMOptions 由 brain 配置映射：model/url/key/thinking/rpm）
       └─ 逐 chunk yield StreamChunk（经 MessageAdapter.extractStreamDelta 归一）
```

## 依赖与关联

- **依赖**：仅类型引用 [`SenseFunction`](./sense.md)（来自 `core/sense/adapter`），无运行时依赖。
- **被依赖**：
  - [`agent/provider/{openai,ollama,mock}.ts`](../../src/agent/provider/) —— `registerLLMAdapter(...)` 注册实现。
  - [`agent/middleware/chat.ts`](../../src/agent/middleware/chat.ts) —— 运行期调 `chatStream`。
  - [`agent/runtimeResolver.ts`](../../src/agent/runtimeResolver.ts) —— 解析 brain 时 `getLLMAdapter`。
  - [`agent/builder.ts`](../../src/agent/builder.ts) —— 间接经 RuntimeConfig 注入。
- **横切参考**：[message.md](./message.md)（响应归一）、[sense.md](./sense.md)（工具定义格式）、[mock.md](../mock.md)（mock provider 测试用法）。

## 扩展点：接新 Provider

1. 在 `src/agent/provider/<name>.ts` 实现 `LLMAdapter`（`chat` / `chatStream`）。
2. 同文件一并实现并注册 [`MessageAdapter`](./message.md) 和 [`SenseAdapter`](./sense.md)（三者通常成套，因为响应格式同源）。
3. 调 `registerLLMAdapter("<provider>", adapter)`，在 [`agent/provider/index.ts`](../../src/agent/provider/index.ts) 的 `registerBuiltinProviders()` 中调用注册函数。
4. 在 `.chery/config.yaml` 添加 brain 配置，`provider` 字段对应注册名。
