# LLM Adapter（模型调用契约）

> 源码 [src/core/llm/adapter.ts](../../src/core/llm/adapter.ts) ｜ 上级 [core/README.md](./README.md) ｜ 相关 [message.md](./message.md)、[sense.md](./sense.md)

## 职责

定义「调用一个大模型」的最小契约：给定消息序列、可用感官（工具）、模型选项，返回**完整响应**或**流式 chunk 异步迭代器**。core 只给接口和注册表，真正的 HTTP/SDK 调用在 [`agent/provider/`](../../src/agent/provider/) 里实现（openai / ollama / mock 三套）。

注意：此文件**不关心响应内容的解析**——它吐出 provider 原生响应对象（`TResponse` / `TStreamChunk`），由 [`MessageAdapter`](./message.md) 负责把原生响应归一为 `LLMResponse`、由 [`SenseAdapter`](./sense.md) 提取 senseCalls。

## 文件清单

| 文件 | 职责 |
|------|------|
| [adapter.ts](../../src/core/llm/adapter.ts) | `LLMOptions`、`LLMAdapter` 接口、`registerLLMAdapter` / `getLLMAdapter` / `resetLLMAdapters` 注册表 |
| [urlPattern.ts](../../src/core/llm/urlPattern.ts) | `ProviderUrlPattern`、`registerProviderUrlPattern` / `getProviderUrlPattern` 注册表（纯数据，零 import） |

> ⚠ 真实代码**没有** `src/core/llm/index.ts`（CLAUDE.md 旧描述与源码不符）；llm 子模块就 `adapter.ts` + `urlPattern.ts` 两个文件。

`urlPattern.ts` 只持类型 + Map，URL 解析逻辑（`resolveProviderUrl`）在 agent 层的 [fetchBase.ts](../../src/agent/provider/fetchBase.ts)（agent 依赖 core 方向合法，core 不反向依赖 agent）。详见 [provider.md](../agent/provider.md)「URL 解析与端点拼接」。

## 核心概念 / 导出

### LLMOptions

调用选项，provider 按需读取。`model` 必选，其余可选。

```ts
export interface LLMOptions {
  model: string;
  url?: string;
  key?: string;
  thinking?: ThinkingLevel;              // 思考档位「显示词」：仅用于日志与 PreLLMRequest hook payload，不进请求体
  thinkingParams?: Record<string, unknown>; // 显示词翻译出的 wire 参数片段（.chery/model-catalog.yaml）；provider 原样 spread
  rpm?: number;             // 每分钟最大请求数，provider 层滑动窗口限流，未配置则不限流
}

/** 思考档位「显示词」。off/on/low/medium/high/xhigh + 任意自定义词（YAML 声明）。
 *  显示词 → 请求参数的映射在 .chery/model-catalog.yaml 的 wire 中声明，chat middleware 统一翻译。 */
export type ThinkingLevel = "off" | "on" | "low" | "medium" | "high" | "xhigh" | (string & {});
```

### ThinkingLevel 全链路与 global 总闸

显示词与请求参数解耦，全链路：

```text
config.yaml brain.<name>.thinking (显示词)
  └─ loadConfig / readRawConfig 归一化（legacy boolean 兼容：true→"on"、false/缺省→"off"；任意非空字符串原样通过）
     → ctx.runtime.brain.thinking (显示词)
        └─ chatMiddleware 构造 LLMOptions（与 global.thinking 做 AND 闸，见下）
           thinking = 显示词（日志 / hook payload 用）
           thinkingParams = resolveThinkingParams(model, thinking)  ← 统一翻译点
              → provider 只做 ...(options?.thinkingParams ?? {}) 直传，不内置映射
```

**模型级档位（settings 渲染 + 请求翻译用）**：`.chery/model-catalog.yaml` 的 `wire.<protocol>.thinking` 声明档位和参数片段；BrainCard 经 `utils.modelRecommendation` 获取档位。未知模型返回空档位并跟随服务默认。详见 [模型目录](../model-catalog.md)。

**global.thinking AND 闸**：`config.yaml` 另有 `global.thinking: boolean`（全局总开关）。`chatMiddleware` 构造 `LLMOptions` 时做 AND：`global.thinking` 为 false 时强制 `"off"`，为 true 时取 `brain.thinking`。即全局开关关闭则一律不思考（`off` 显示词的 params 片段生效——若 YAML 为该模型声明了显式关闭片段如 `thinking:{type:disabled}`，总闸关闭也会显式下发）。

**provider 直传约定**：provider **不再内置任何档位词映射**，只在请求体组装时 spread `options.thinkingParams`；协议专属字段（如 MiniMax 的 `thinking:{type:...}` / `reasoning_split`、Anthropic 的 `output_config`）直接写在 YAML 片段里。mock / ollama 请求侧不消费（mock 脚本回放、ollama 由服务端决定）。详见 [provider.md](../agent/provider.md)「thinking 参数片段直传」。

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
       │  （LLMOptions 由 brain 配置映射：model/url/key/thinking/thinkingParams/rpm）
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
4. 调 `registerProviderUrlPattern("<provider>", { chatEndpoint, modelsEndpoint })` 声明 URL 端点拼接能力（**必须提供**，见 [provider.md](../agent/provider.md)「URL 解析与端点拼接」）；host 模式的 provider（ollama 类）可不注册。
5. 在 `.chery/config.yaml` 添加 brain 配置，`provider` 字段对应注册名。
