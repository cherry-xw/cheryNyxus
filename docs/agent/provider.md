# Agent Provider（LLM 服务适配）

> 源码 [src/agent/provider/](../../src/agent/provider/) ｜ 上级 [agent](./README.md) ｜ Mock 脚本 [../mock.md](../mock.md)

## 职责

为每个 LLM 服务（openai / ollama / mock）注册三层 Adapter（LLM + Message + Sense），把 provider 特定的响应格式与调用约定封装成统一的接口，供 [RuntimeResolver](../../src/agent/runtimeResolver.ts) 按 `brain.provider` 取用。

每个 Provider 文件导出一个 `register<Name>Adapter()` 函数，调用 core 的三个 registry：

```text
registerLLMAdapter(name, llmAdapter)           ← core/llm/adapter
registerMessageAdapter<Raw, Stream, Msg>(...)  ← core/message/adapter
registerSenseAdapter<Msg, Raw>(name, cfg)      ← core/sense/adapter
```

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [index.ts](../../src/agent/provider/index.ts) | `registerBuiltinProviders()`：幂等注册 openai/deepseek/ollama/mock/bigmodel/anthropic |
| [openai.ts](../../src/agent/provider/openai.ts) | OpenAI（含兼容服务）三件套，含 RPM 限流、`reasoning_effort` 映射、`reasoning_content` 提取、`strict:true` |
| [ollama.ts](../../src/agent/provider/ollama.ts) | Ollama 三件套，含 `tool_calls` 处理与流式不可靠警告 |
| [mock.ts](../../src/agent/provider/mock.ts) | 脚本回放 provider（离线测试），按 LLM 调用序逐条回放 |
| [bigmodel.ts](../../src/agent/provider/bigmodel.ts) | 智谱 BigModel 三件套（fetch 实现），`reasoning_effort` 映射、`reasoning_content` 提取、image 多模态 |
| [anthropic.ts](../../src/agent/provider/anthropic.ts) | Anthropic Messages API 三件套（fetch 实现），native fetch + x-api-key + typed SSE + PreLLMRequest hook |
| [deepseek.ts](../../src/agent/provider/deepseek.ts) | DeepSeek Chat Completions 三件套，按工具调用条件回传 `reasoning_content` |

## 核心概念 / 导出

### registerBuiltinProviders（[index.ts](../../src/agent/provider/index.ts)）

```ts
let builtinProvidersRegistered = false;
export function registerBuiltinProviders(): void {
  if (builtinProvidersRegistered) return;          // 幂等
  registerOpenAIAdapter();
  registerOllamaAdapter();
  registerMockAdapter();
  builtinProvidersRegistered = true;
}
```

由 [bootstrap.ts](../../src/agent/bootstrap.ts) 在服务启动前显式调用——避免 `import AgentBuilder` 时产生注册副作用。

### 三层 Adapter 的接口契约

| Adapter | 接口 | 文件 |
|---------|------|------|
| LLM | `chat()/chatStream()` 调用 LLM | [core/llm/adapter.ts](../../src/core/llm/adapter.ts) |
| Message | `content/thinking/extractStreamDelta/extractStreamThinking/buildMessages` | [core/message/adapter.ts](../../src/core/message/adapter.ts) |
| Sense | `buildSenses/senseCalls/extractSenseCallDeltas` | [core/sense/adapter.ts](../../src/core/sense/adapter.ts) |

### 设置页连接测试

`utils.testConnection` 使用用户尚未保存的 `provider/url/key/model`，先通过 Message Adapter 将单条“只回复 OK”消息转换为 provider 原生形状，再调用 LLM Adapter 的非流式 `chat()`。该路径只验证 Provider 连通、鉴权和模型可用性：不创建 chat、不挂载 sense、不进入 middleware/retry，也不持久化配置或消息。

内部 `LLMOptions.skipHooks=true` 仅供此探测路径使用。Anthropic Adapter 据此跳过 `PreLLMRequest`；正式 chat 不传该字段，Hook 行为不变。Mock 是本地脚本回放，没有网络连通语义，设置页禁用测试按钮。

### Provider 能力差异

| 维度 | openai | deepseek | ollama | mock | bigmodel | anthropic |
|------|--------|----------|--------|------|----------|-----------|
| thinking 请求参数 | `reasoning_effort:level`（off 省略） | `thinking.type` + `reasoning_effort` | 无（不传） | N/A | `reasoning_effort:level`（同 openai） | `thinking:{type:'adaptive'}` + `output_config.effort`（off 省略） |
| thinking 响应字段 | `reasoning_content` | `reasoning_content` | `message.thinking` | `thinking` | `reasoning_content` | `content[].thinking` / `redacted_thinking` blocks（含 signature） |
| `buildSenses` 加 `strict:true` | ✓ | ✗ | ✗ | ✓ | ✗（Anthropic 不支持） |
| tool_call.id | 有（`call_xxx`） | 无（randomUUID 占位） | 缺省 randomUUID | 有 | 有（`toolu_xxx`） |
| 流式 tool_call 稳定 | 稳定 | 不稳定（P1-2） | 稳定（自拆 delta） | 稳定（OpenAI 协议） | 稳定（typed SSE） |
| RPM 限流 | ✓（`brain.rpm`） | ✗ | ✗ | ✓（`brain.rpm`） | ✓（`brain.rpm`） |
| 真实网络 | 是 | 是 | 否（脚本回放） | 是 | 是 |
| buildMessages 把 `sense` 转 `tool` result | ✓（带 `tool_call_id`） | ✓（仅 role+content） | ✗（直接透传 LLMResponse） | ✓（同 openai） | ✓（嵌 user 消息 tool_result block） |
| system prompt 字段 | messages 首条 | messages 首条 | messages 首条 | messages 首条 | **顶层 `system` 字段**（buildMessages 抽取） |
| HTTP 实现 | openai SDK | ollama SDK | 脚本回放 | 原生 fetch（fetchBase） | 原生 fetch（私有 anthropicFetch/SSE） |
| PreLLMRequest hook | ✗ | ✗ | ✗ | ✗ | ✗ | ✓（anthropic provider 自动 dispatch） |

### 思考上下文回传策略

接收、展示和持久化 `thinking` 与把它拼回下一次请求是两项独立策略。OpenAI 与 BigModel 在 assistant 历史中回传 `reasoning_content`，Ollama 回传原生 `thinking`，Anthropic 以原生 thinking block 回传（含 signature 完整块），Mock 原样回放。DeepSeek 遵循其[思考模式文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)：普通 assistant 轮不拼接 `reasoning_content`，但带 `tool_calls` 的 assistant 轮必须在之后所有请求中原样回传，否则 API 返回 400。

### Anthropic 扩展思考块协议（extended thinking blocks）

[Anthropic Messages API](https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking) 在开启扩展思考时强制要求：

> 在后续轮次中，必须把完整的 `thinking` / `redacted_thinking` content block 原样回传（含 `signature` 字段），否则 API 400。

实现细节：

- **双轨并存**：`LLMResponse.thinking` 保留拼接字符串（UI 展示 + token 估算 + 非 Anthropic 回退），新增 `LLMResponse.thinkingBlocks?: ThinkingBlock[]`（Anthropic 专属 round-trip 用）。两者独立填充，UI 不读 blocks。
- **流式累积**：`anthropicMessageAdapterConfig.extractStreamThinkingBlocks` 把 SSE 事件翻译成 `ThinkingBlockDelta[]`（start/text/signature/stop），由 `chat.ts` / `checkpointState.ts` 内的 `ThinkingBlockAssembler`（[src/agent/provider/thinkingBlockAssembler.ts](../../src/agent/provider/thinkingBlockAssembler.ts)）按 index 累积，产出 `ThinkingBlock[]`。
- **落库**：`messages.thinking_blocks TEXT` JSON 列（与 `thinking` 并存）。schema migration 自动 `ALTER TABLE ADD COLUMN thinking_blocks TEXT` 兜底旧库。
- **回传**：`anthropic.ts` 的 `pushThinkingBlocks` 在 `buildMessages` 时优先用 `m.thinkingBlocks`（含 signature），无则降级 `m.thinking` 字符串（legacy fallback — Anthropic 会拒 400，已文档化）。
- **协议违规兜底**：thinking 块缺 signature 时仍按原样 emit；调用方应据 `thinkingBlocks` 完整性判断是否使用 Anthropic brain。

已知限制：跨 provider 历史切换（OpenAI session 切到 Anthropic brain）→ legacy fallback 无 signature，下一轮必 400。建议切换 brain 时新建 chat。

### 第三方 Anthropic 模式端点兼容（coding-plan 代理）

大量 3rd-party Anthropic 模式端点（如 Claude Code 风格的 coding-plan 代理）并不实现 `redacted_thinking` 块（此特性较新，仅官方 Anthropic API 支持）；按 Anthropic 协议原样回传会被这些端点拒 400。

适配方式：**brain 级配置 `anthropicCompat.official`**：

```yaml
llm:
  brain:
    anthropic_main:  # 官方 Anthropic API
      provider: anthropic
      anthropicCompat:
        official: true   # 完整协议：保留 redacted_thinking 原样回传
    anthropic_proxy:  # 3rd-party coding-plan 代理
      provider: anthropic
      anthropicCompat:
        official: false  # 默认：strip redacted_thinking，3rd-party 兼容
```

- `official=false`（默认）：buildMessages 时跳过 `redacted_thinking` 块，其它块（含 signature 的 thinking）原样保留。
- `official=true`：完整 Anthropic 协议，包括 redacted 块原样回传。

前端 BrainCard 在 `provider === 'anthropic'` 时显示「官方」勾选开关，与 yaml 同步。

### URL 解析与端点拼接（provider 注册能力）

**背景**：早期 anthropic provider 曾自动在 base URL 后拼 `/v1/messages`；后改为「版本前缀由用户在 `cfg.url` 自己写」但未做迁移提示，导致旧配置（url 不带 `/v1`）静默失效——请求落到网关的 Web 控制台回退页（200 + HTML），表现为「run 空转、无任何报错」（见下节流完整性校验）。现收敛为**注册 provider 必须提供的能力**：`ProviderUrlPattern` 注册表 + 统一入口 `resolveProviderUrl`，地址只做简单拼接，最多对结尾 `/` 做归一（`https://x:11411/` 与 `https://x:11411` 等价）。

**规则（2026-08 简化）**：**版本段（`/v1` 等）由用户填写，后端只自动拼端点**（`/chat/completions`、`/messages`、`/models`）——不再自动补 `/v1`。未勾选「完整 URL」时 url 须含版本段，如 `https://yz.xcherry.top:11411/v1`，请求落点为 `…/v1/chat/completions`。前端地址输入框 placeholder 已注明此约定。

#### 能力声明（`ProviderUrlPattern`）

URL 端点是 provider 的**注册能力**，不是全局通用逻辑——endpoint 路径是 provider 协议的一部分，不能全局统一。每个 provider 注册时声明 `chat` / `models` 两种 kind 的端点模式（[core/llm/urlPattern.ts](../../src/core/llm/urlPattern.ts)，纯数据注册表，零 import）：

| provider | `chatEndpoint` | `modelsEndpoint` | 说明 |
|----------|---------------|------------------|------|
| openai | `''`（base 原样，SDK 自拼端点） | `''`（同左） | 未勾选：SDK 自拼 `/chat/completions`、`/models`；**勾选 fullUrl：绕开 SDK**，`chat`/`chatStream`/models 拉取全部改走 fetchBase 原生请求，实际请求 = 用户填写的 URL 本身 |
| anthropic | `/messages` | `/models?limit=1000` | 原生 fetch，`base + endpoint` |
| deepseek | `/chat/completions` | `''`（base 原样，openai SDK） | chat 走 fetchBase，models 走 openai SDK |
| bigmodel | `/chat/completions` | 未声明 | `models` 不支持（`utils.models` 报「不支持」） |
| ollama / mock | 不注册 | 不注册 | host 模式，无版本段概念 |

- `chatEndpoint` / `modelsEndpoint` **三态语义**：
  - `undefined` → host 模式，不拼接（未注册，或该 kind 不支持）。
  - `''` → 不拼端点，base 原样（端点由 openai SDK 自拼；**版本段由用户填写**）。
  - `'/xxx'` → 拼端点（如 `/messages`、`/chat/completions`）。
- `fullUrl=true` 时**完全不拼接**（仅去尾斜杠），直接以用户填写的 URL 访问后端。

#### 统一入口 `resolveProviderUrl`

```ts
resolveProviderUrl(provider, url, { fullUrl, kind })   // kind ∈ 'chat' | 'models'
```

- 定义在 [`agent/provider/fetchBase.ts`](../../src/agent/provider/fetchBase.ts)：查注册表取 `pattern[kind]` → `undefined` 走 host 模式（原样去尾斜杠），否则交 `buildEndpointUrl` 两分支（`fullUrl` 原样 / 否则 `base + endpoint`）。
- 注册表在 [`core/llm/urlPattern.ts`](../../src/core/llm/urlPattern.ts)：只持类型 + Map（`registerProviderUrlPattern` / `getProviderUrlPattern`），**零 import**；解析逻辑放 agent 层（core 不反向依赖 agent）。
- **chat / models 拉取 / 测试连接全部走同一入口**：正式 chat、`utils.models`、`utils.testConnection` 三处 URL 行为一致，不会出现「测试连通、实际跑挂」的拼接不一致。

#### 分层调用

| 场景 | 入口 | kind |
|------|------|------|
| openai chat | 未勾选：`resolveProviderUrl('openai', url, { kind: 'chat' })`（SDK baseURL，base 原样）；**勾选 fullUrl：`jsonRequest` / `streamSSE` 直接请求用户 URL** | chat |
| anthropic chat（`joinAnthropicUrl`） | `resolveProviderUrl('anthropic', url, { fullUrl, kind: 'chat' })` | chat |
| bigmodel / deepseek chat | `jsonRequest` / `streamSSE` 内部协议常量（见下） | chat |
| `utils.models` openai/deepseek | 未勾选：`resolveProviderUrl(provider, url, { kind: 'models' })` → SDK baseURL（base 原样）；**勾选 fullUrl：原生 fetch 直接请求用户 URL** | models |
| `utils.models` anthropic | `resolveProviderUrl('anthropic', url, { fullUrl, kind: 'models' })` → 原生 fetch | models |

- ⚠️ **openai 勾选 fullUrl 的语义**：openai SDK 强制在 baseURL 后拼 `/chat/completions` / `/models`，无法做到「零拼接」。因此勾选 fullUrl 后 openai 的 `chat`/`chatStream` **绕开 SDK**，改走 fetchBase 的 `jsonRequest` / `streamSSE`（与 bigmodel/deepseek 的 fetch 路径同款），models 拉取改原生 fetch——**实际请求 URL = 用户填写的值本身**（仅去尾斜杠），彻底兑现「完整 URL 完全自负责」。请求体仍为 OpenAI 兼容协议（POST 到用户 URL）。
- ⚠️ `jsonRequest` / `streamSSE`（fetchBase.ts）内部的 `/chat/completions` 是 **openai 兼容协议常量**（bigmodel/deepseek 共用），非 provider 特性，**保持不收敛**——它们已正确透传 `fullUrl`，与注册值的一致性由单测锁死防漂移。
- `fullUrl` 经 `BrainConfig` → `LLMOptions` → provider 逐层透传（[middleware.md chat.ts](./middleware.md)）；前端 BrainCard 显示「完整 URL」勾选，与 yaml 同步。勾选后**后端不做任何拼接**（仅去尾斜杠），请求 URL 即用户填写的原值。
- ⚠️ `fullUrl` 语义（2026-08）：勾选 = **完全不拼接**。若勾选且 url 未含完整端点，请求直接落到该地址（如填 `…/v1` 访问 anthropic 会 404）——fullUrl 下 url 由用户完全自负责。
- ⚠️ 已知边界：anthropic 勾选 fullUrl 后，「刷新模型」请求地址 = 用户填写的完整 URL（须含 `/models` 端点），与 chat 的 `…/v1/messages` 同用一个 `url` 字段**不可兼得**——fullUrl「完全自负责」语义的固有张力，填完整 URL 时按需取舍。
- ⚠️ 兼容性（2026-08 简化）：**不再自动补版本段**——url 未含版本段的旧配置会失效（如 openai 填 `https://x:11411` 未勾选会请求到 `https://x:11411/chat/completions` 而非 `…/v1/chat/completions`），需在 url 中补上版本段（如 `https://x:11411/v1`）。placeholder 已提示。

### 流完整性校验（伪 200 / 空流拦截）

网关（new-api/one-api 类）对未知 API 路径常回退到 Web 控制台 SPA（**HTTP 200 + HTML**）；若端点异常也可能返回 200 但流内 0 个事件。两者原先都被 SSE 解析器当「正常空响应」静默吞掉，用户只看到「点了运行但毫无动静」。现两条路径都显式拦截：

| 场景 | 检测点 | 错误分类 | 用户文案 | retry 行为 |
|------|--------|---------|---------|-----------|
| 伪 200（content-type 非 `text/event-stream` / `application/json`） | `res.ok` 之后、读流之前 | `validation` | 大脑配置可能有误：端点返回的不是事件流（url 可能缺 /v1 前缀），请在设置里检查 | 不重试，立即报前端 |
| 空流（流正常结束但 0 个有效事件） | SSE 行循环结束处 | `provider` | 大模型调用失败：响应流为空 | 按 provider 类可重试一次，仍空则报前端 |
| 非流式响应体非 JSON（`res.json()` 失败） | `anthropicFetch` / `jsonRequest` | `validation` | 同伪 200 | 不重试 |

覆盖文件：[anthropic.ts](../../src/agent/provider/anthropic.ts)（`anthropicFetch`/`anthropicStreamSSE`）与 [fetchBase.ts](../../src/agent/provider/fetchBase.ts)（`jsonRequest`/`streamSSE`）——openai SDK 路径的等价校验由 SDK 自身抛错 + `classifyBrainError` 兜底。错误经 `ClassifiedError` → retry 中间件 → streamMapper 出口（`[tracingId] 文案`）到达前端。

### 三 Provider 共有约定

- **sense 消息转 tool result：** openai/ollama 的 `buildMessages` 都把 `role:"sense"` 历史消息转成 provider 的 tool 结果消息（openai 用 `tool_call_id`，ollama 用 `role:"tool"`），并处理 `replace.state`（历史 hash 替换）时改用 `replace.content`。
- **revoked 过滤：** 三者 `buildMessages` 都 `filter(m => !m.revoked)` 排除撤回消息（撤回场景见 [../interaction.md](../interaction.md)）。
- **buildBaseSenseFunction：** 三者 `buildSenses` 都调 [core/sense/compiler/utils.ts](../../src/core/sense/compiler/utils.ts) 的 `buildBaseSenseFunction(s)` 生成统一的 `function.name/description/parameters` 字段，再各自补 provider 特定字段（openai 加 `strict`）。

## 关键流程

### Provider 注册与取用

```text
【启动期注册】
bootstrapAgentRuntime → registerBuiltinProviders()
  ├─ registerOpenAIAdapter()   → 三个 registry 写入 "openai"
  ├─ registerOllamaAdapter()   → 三个 registry 写入 "ollama"
  └─ registerMockAdapter()     → 三个 registry 写入 "mock"

【每轮取用】
RuntimeResolver.resolveBrain(name)
  ├─ brain = config.llm.brain[name]
  ├─ provider = brain.provider
  ├─ llmAdapter    = getLLMAdapter(provider)
  ├─ messageAdapter = getMessageAdapter(provider)
  └─ senseAdapter  = getSenseAdapter(provider)
```

### chat 层调用 LLM（[../middleware.md chat.ts](./middleware.md)）

```text
chatMiddleware → ctx.runtime.adapters
  ├─ ctx.global.stream === true → llmAdapter.chatStream(msgs, senses, options)
  │     for await raw → messageAdapter.extractStreamDelta/extractStreamThinking
  │                    + senseAdapter.extractSenseCallDeltas
  │                    → yield StreamChunk
  └─ false → llmAdapter.chat(msgs, senses, options)
        → messageAdapter.content/thinking + senseAdapter.senseCalls
        → yield 单个 StreamChunk
```

### OpenAI 的 RPM 限流（[openai.ts acquireRpm](../../src/agent/provider/openai.ts)）

```ts
async function acquireRpm(options?: LLMOptions): Promise<void> {
  const rpm = options?.rpm;
  const url = options?.url;
  if (!rpm || rpm <= 0 || !url) return;       // 未配置/无 url 跳过
  await getRateLimiter(url, options.key, rpm).acquire();   // (url,key) 滑动窗口
}
```

`brain.rpm` 配置时，`chatMiddleware` 构造 `options` 会展开 `rpm`（[chat.ts](../../src/agent/middleware/chat.ts)），`acquireRpm` 在每次 `chat`/`chatStream` 前节流。

### Mock 的索引机制（[mock.ts pickScriptItem](../../src/agent/provider/mock.ts)）

```ts
const index = messages.filter(m => m.role === "assistant").length;
// script[index]；耗尽后 repeat==="last" 重复最后一条，否则返回空
```

**为何如此设计：** 每次 LLM 调用产生一个 assistant 轮 → 已调用次数 = 下一个 script 下标。**无状态、天然 per-chat**（每个 chat 独立计数）。**撤回自动回退**：`buildMessages` 过滤 revoked，被撤回的 assistant 不计入 → 索引回到撤回前。

`chatStream` 把一条 script 项拆成 3 个 delta chunk（thinking / content / toolCalls 各一），触发 checkpoint 的 delta 状态机（[../middleware.md 关键流程 C/D](./middleware.md)）。

详见 [../mock.md](../mock.md)。

## 依赖与关联 ⭐

### 依赖

| 依赖 | 用途 |
|------|------|
| [core/llm/adapter](../../src/core/llm/adapter.ts) | `LLMAdapter` 接口、`registerLLMAdapter`、`LLMOptions` |
| [core/message/adapter](../../src/core/message/adapter.ts) | `MessageProviderAdapterConfig`、`registerMessageAdapter`、`LLMResponse` |
| [core/sense](../../src/core/sense/) | `registerSenseAdapter`、`Sense`/`SenseCallData`/`SenseFunction`/`SenseAdapter` |
| [core/sense/compiler/utils](../../src/core/sense/compiler/utils.ts) | `buildBaseSenseFunction`（统一 function 字段生成） |
| [utils/config](../../src/utils/config.ts) | `config.llm.brain`（mock 找脚本文件路径）、`MockScriptResponse` 类型 |
| [utils/rateLimiter](../../src/utils/rateLimiter.ts) | `getRateLimiter`（仅 openai） |
| [utils/logger](../../src/utils/logger/) | ollama 流式警告、mock 日志 |
| 第三方 | `openai`、`ollama`、`zod`、`js-yaml`、`fs`/`path` |

### 被依赖

| 调用方 | 用途 |
|--------|------|
| [agent/provider/index.ts](../../src/agent/provider/index.ts) | `registerBuiltinProviders()` 串联 |
| [agent/bootstrap.ts](../../src/agent/bootstrap.ts) | 启动期调用 `registerBuiltinProviders()` |

### 横切参考

- [../mock.md](../mock.md) — mock provider 的完整使用指南：脚本文件格式、测试场景对照表、配置示例
- [./middleware.md](./middleware.md) chat 层 — 如何消费 LLM/Message/Sense adapter
- [../../README.md](../../README.md) — config.yaml 中 `llm.brain.<name>.provider` 字段对应这里的注册名

## 三 Provider 详解

### OpenAI（[openai.ts](../../src/agent/provider/openai.ts)）

**LLM Adapter：**

```ts
{
  async chat(messages, senses, options): Promise<ChatCompletion> {
    // key 缺失（brain 未配 key / $ENV 占位符未替换）→ 运行期抛错；
    // 详细上下文走 logger 落盘，message 短直白 + tracingId 用于问询查询
    // 占位符 $VAR 必须也视为缺失——env 未配置时 replaceEnvVars 原样返回占位符，
    // 不拦截会作为 token 发出 → 后端 401，错误信息毫无指引
    const placeholderMatch = key?.match(/^\$([A-Z_][A-Z0-9_]*)$/);
    if (placeholderMatch) {
      const envName = placeholderMatch[1]!;
      const tracingId = newTracingId();
      logger.event("llm.key.missing", { tracingId, model, url, envName, reason: "placeholder_unresolved" }, LogLevel.error);
      throw new Error(`${model} 缺少 key。请在 .env 或环境变量中设置 ${envName} 后重启 [${tracingId}]`);
    }
    if (!key) {
      const tracingId = newTracingId();
      logger.event("llm.key.missing", { tracingId, model, url, reason: "key_empty" }, LogLevel.error);
      throw new Error(`${model} 缺少 key。请在 .chery/config.yaml 的 llm.brain 段检查 key 字段 [${tracingId}]`);
    }
    await acquireRpm(options);
    const client = new OpenAI({ baseURL: url, apiKey: key });
    return client.chat.completions.create({
      model, messages,
      ...(effort && { reasoning_effort: effort }),  // 思考强度：low/medium/high（off 省略）
      ...(senses.length > 0 && { tools: senses }),
    });
  },
  // chatStream 同上 + stream:true，返回 AsyncIterable
}
```

**key 缺失策略**：`brain.key` 不参与启动校验（缺失不阻止启动），运行期 `chat`/`chatStream` 调用时按以下顺序检查：

1. **占位符检测**：key 形如 `^\$([A-Z_][A-Z0-9_]*)$` → 抛 `${model} 缺少 key。请在 .env 或环境变量中设置 ${envName} 后重启 [${tracingId}]`。[replaceEnvVars](../../src/utils/config.ts) 在 env 缺失时**原样返回占位符**，必须也视为缺失。
2. **完全缺失**：`!key`（undefined / 空串）→ 抛 `${model} 缺少 key。请在 .chery/config.yaml 的 llm.brain 段检查 key 字段 [${tracingId}]`。

**错误信息分层原则**：
- **用户面**（抛出的 message）：`model 缺失 + 修复路径 + 8 位 tracingId`（如 `glm-5.2 缺少 key。请在 .env 或环境变量中设置 API_KEY 后重启 [1c538629]`）—— 直白可读，足够用户自助修复
- **日志面**（`logger.event("llm.key.missing", {...})`）：结构化 JSON 事件，含 `tracingId` + `model` + `url` + `envName` + `reason`（`placeholder_unresolved` / `key_empty`）—— 用户报问题时给 tracingId，可凭此 id 全文检索日志还原完整上下文

错误消息避开 [retry 中间件](./middleware.md) 的可恢复关键词（`api`/`invalid`/`timeout` 等），落到 retry 的 `unknown` 分类 → 不重试、直接响应前端。

**Message Adapter：**

| 方法 | 实现 |
|------|------|
| `content` | `raw.choices[0]?.message?.content ?? ""` |
| `thinking` | `raw.choices[0]?.message?.reasoning_content`（兼容思考模型） |
| `extractStreamDelta` | `chunk.choices[0]?.delta?.content ?? ""` |
| `extractStreamThinking` | `chunk.choices[0]?.delta?.reasoning_content` |
| `buildMessages` | 见下方 |

buildMessages 关键转换（[openai.ts](../../src/agent/provider/openai.ts)）：

| 历史消息 | 转换 |
|----------|------|
| `role:"sense"` | `{ role:"tool", content: replace.state ? replace.content : m.content, tool_call_id: m.id }` |
| `role:"assistant"` 有 senseCalls | `{ role, content: m.content ?? null, tool_calls: [{id,type:"function",function:{name,arguments}}...] }` |
| 其他 | `{ role, content }` |

**Sense Adapter：**

```ts
buildSenses(senses) { return senses.map(s => ({ type:"function", function: { ...buildBaseSenseFunction(s), strict: true } })); }
senseCalls(response) { /* 从 response.choices[0].message.tool_calls 提取 */ }
extractSenseCallDeltas(chunk) { /* 从 chunk.choices[0].delta.tool_calls 提取，index 定位 */ }
```

### Ollama（[ollama.ts](../../src/agent/provider/ollama.ts)）

**与 OpenAI 的差异：**

- thinking 走 `message.thinking` 字段（非 `reasoning_content`）。
- `buildSenses` **不加** `strict:true`（ollama 不支持）。
- `tool_calls` 无 `id` 字段——非流式路径每次 `chat()` 都重新调 LLM 拿新 response，id 随新响应新生，故 `randomUUID()` 占位可接受；**流式不可靠**（见下方 P1-2）。
- `buildMessages` 把 `role:"sense"` 转 `role:"tool"`（仅 role+content，无 `tool_call_id`，ollama API 不识别原 sense role）。
- `chat` / `chatStream` 每次按 `LLMOptions.url` 创建 `Ollama({ host })` 客户端，保证配置地址、设置页连接测试与正式请求一致；缺地址时按现有 SDK 默认地址处理。
- **无 RPM 限流**（未调 `acquireRpm`）。

**P1-2 流式感官不可靠警告（[ollama.ts extractSenseCallDeltas 注释](../../src/agent/provider/ollama.ts)）：** Ollama 流式响应**不稳定**返回 `tool_calls`（多数场景流式不产生 tool_call），且无 `tool_call.id`。`randomUUID` 仅占位，同 call 多 chunk 由 `checkpointState.mergeSenseDeltas` 取首 delta id 合并。**建议需要感官调用时走非流式（`senseCalls`）路径**——`chatStream` 检测到 `senses.length > 0` 时会 `logger.warn`。

### Mock（[mock.ts](../../src/agent/provider/mock.ts)）

**自定义 raw 格式：**

```ts
interface MockToolCall { index: number; id: string; name: string; arguments: string; }
interface MockStreamChunk { thinking?: string; content?: string; toolCalls?: MockToolCall[]; }
interface MockResponse { thinking?: string; content?: string; toolCalls?: MockToolCall[]; }
```

**LLM Adapter：**

```ts
{
  async chat(messages, _senses, options) {
    const item = pickScriptItem(options.model, messages);
    if (item.error) throw new Error(item.error);   // 触发 retry 中间件
    return toResponse(item);
  },
  async chatStream(...) {
    // 拆 delta：thinking / content / toolCalls 各一 chunk，触发 checkpoint delta 状态机
    async function* gen() {
      if (resp.thinking) yield { thinking: resp.thinking };
      if (resp.content) yield { content: resp.content };
      if (resp.toolCalls?.length) yield { toolCalls: resp.toolCalls };
    }
    return gen();
  }
}
```

**Message/Sense Adapter：** 极简——`buildMessages` 直接 `filter(!revoked)` 透传 LLMResponse（mock 不接真实 API，无需格式转换）；`buildSenses` 仅包 `{type:"function", function: buildBaseSenseFunction(s)}`；`extractSenseCallDeltas` 从 `MockStreamChunk.toolCalls` 直接提取。

**脚本文件查找（[mock.ts findMockFile/loadScriptFile](../../src/agent/provider/mock.ts)）：**

- `findMockFile(model)`：遍历 `config.llm.brain`，匹配 `provider==="mock" && model` → 取 `b.mock.file`。
- `loadScriptFile(file)`：读 `.chery/<file>`（不缓存——dev 改脚本免重启）；文件不存在 warn 返回 `{script:[]}`。

> **完整 mock 用法、脚本格式、测试场景对照表见 [../mock.md](../mock.md)。**

## 扩展点

### 添加 Provider

1. 在 [provider/](../../src/agent/provider/) 新增 `<name>.ts`。
2. 定义三层 adapter 配置对象（参考 [ollama.ts](../../src/agent/provider/ollama.ts) 最简模板）：

   ```ts
   import { registerLLMAdapter, type LLMAdapter, type LLMOptions } from "@/core/llm/adapter";
   import { registerMessageAdapter, type LLMResponse } from "@/core/message/adapter";
   import { registerSenseAdapter, type Sense, type SenseCallData, type SenseFunction } from "@/core/sense";
   import { buildBaseSenseFunction } from "@/core/sense/compiler/utils.js";
   import type { ZodType } from "zod";

   const messageAdapterConfig = { content, thinking, extractStreamDelta, extractStreamThinking, buildMessages };
   const senseAdapterConfig  = { buildSenses, senseCalls, extractSenseCallDeltas };
   const llmAdapter: LLMAdapter = { async chat(...) {...}, async chatStream(...) {...} };

   export function registerMyProviderAdapter(): void {
     registerMessageAdapter<RawType, StreamType, MsgType>("myname", messageAdapterConfig);
     registerSenseAdapter<MsgType, RawType>("myname", senseAdapterConfig);
     registerLLMAdapter("myname", llmAdapter);
   }
   ```

3. 在 [index.ts](../../src/agent/provider/index.ts) 的 `registerBuiltinProviders()` 中调用 `registerMyProviderAdapter()`。
4. 在 `config.yaml` 的 `llm.brain.<name>` 配置 `provider: myname`。
5. ⚠ 三层 adapter 必须用**同一 provider name** 注册——`RuntimeResolver.resolveBrain` 用 `brain.provider` 同时取三个，任一缺失抛 `Provider "..." adapters not registered`。

### 实现要点

- **流式与非流式都要实现**：`ctx.global.stream` 切换路径（[chat.ts](../../src/agent/middleware/chat.ts)）。
- **buildMessages 必须过滤 revoked**：否则撤回后旧消息仍进入 LLM 上下文。
- **buildMessages 必须处理 `replace.state`**：sense 历史 hash 替换时用 `replace.content` 替代原 content（[tool.ts doExecuteSense](../../src/agent/middleware/tool.ts) 的去重逻辑）。
- **tool_call.id 不可省**：openai 要求 assistant 的 `tool_calls[i].id` 与 tool 结果的 `tool_call_id` 配对；provider 没有真实 id 时用 `randomUUID()`，但要注意流式场景同 call 多 chunk 的 id 一致性（由 `mergeSenseDeltas` 取首 delta id 合并）。

### fetch 基座（[fetchBase.ts](../../src/agent/provider/fetchBase.ts)）

新 provider **优先用原生 fetch 而非引第三方 SDK**（Node ≥20 自带 fetch/ReadableStream/AbortController）。基座提供：

- `streamSSE(url, body, key, signal?, opts?): AsyncGenerator<Record<string,unknown>>` —— SSE 流式：内部自建 `AbortController`、`getReader()` + `TextDecoder` 跨 chunk 行缓冲、按 `\n` 切行、跳过空行/`:` 注释心跳、剥离 `data:` 前缀、`[DONE]` 主动结束；**finally 必跑 `controller.abort()` + `reader.cancel()`**（对接现有 abort 机制：`compose.ts` 的 `generator.throw()` → for-await 释放 → finally 切断 HTTP）。`opts.fullUrl` 控制 url 解析（见上文「URL 解析与端点拼接」）；**content-type 校验 + 空流拦截**见上文「流完整性校验」。
- `jsonRequest(url, body, key, signal?, opts?): Promise<Record<string,unknown>>` —— 非流式；`opts.fullUrl` 同上，响应体非 JSON 报 `validation` 错。
- `buildEndpointUrl(url, opts)` —— 导出的 url 拼接工具（`{fullUrl, endpoint}`）：`fullUrl` 原样返回（不拼接任何字符串）；否则 `base + endpoint`（版本段由用户填写，后端只拼端点，不再自动补 `/v1`）。openai 兼容 provider 共用；anthropic 自有同款实现（`joinAnthropicUrl`）。
- `assertChatOptions(options)` —— model/url/key 校验 + `$ENV` 占位符检测（从 openai.ts 抽出，共用）。
- 错误封装：`!res.ok` → `brainHttpError`（按 status 定 category）；网络错误 `brainNetworkError`；伪 200/空流见「流完整性校验」表。

> abort 不靠下传 signal，而靠 generator 生命周期：外层 `for await` 被 `.throw()` 打断时 async generator 的 finally 自动跑、HTTP 连接被切断（与现有 openai SDK 路径行为一致）。

### ThinkingLevel → 请求参数映射

每个 provider 自行把 `LLMOptions.thinking`（`ThinkingLevel`，见 [llm.md](../core/llm.md)）翻译成厂商请求参数。共享映射 `mapThinkingToReasoningEffort(level)`（在 [openaiCompat.ts](../../src/agent/provider/openaiCompat.ts)）：

- `off` → 返回 `undefined`（provider 省略该参数，绝对安全）。
- `on` → 返回 `undefined`（不传参，由模型/服务端决定；语义「开启思考但不给强度」）。
- `low/medium/high` → 返回 `"low"|"medium"|"high"`，塞入 `reasoning_effort` 字段（OpenAI o1 系 / 智谱 bigmodel / OpenAI 兼容聚合端点均认）。

> ⚠ `reasoning_effort` 仅对**推理模型**有效，非推理模型返回 400；`off`/`on` 档省略参数无此风险。ollama provider 全档忽略 thinking（不传，由服务端/模型决定）。未来 anthropic provider 将映射为 thinking block。

### 模型级档位查询

`.chery/model-thinking.yaml` 声明每个模型支持的档位子集（详见 [../utils/README.md#modelThinking.ts — 模型档位映射](../utils/README.md)）。前端 BrainCard 经 `utils.thinkingLevels` RPC 拉取当前 model 的可选档位列表，渲染「深度思考」旋钮。后端在 [src/utils/modelThinking.ts](../../src/utils/modelThinking.ts) 实现，匹配顺序：精确 → 最长前缀 → 通配 `*` → 兜底 `["off","on"]`。

### 共享件（[openaiCompat.ts](../../src/agent/provider/openaiCompat.ts)）

OpenAI 兼容协议的 provider（openai / bigmodel）共享 message/sense adapter 配置 + `acquireRpm` + `mapThinkingToReasoningEffort` + `assertChatOptions`，抽到 `openaiCompat.ts`。openai.ts 用 SDK 实现 LLMAdapter、bigmodel.ts 用 fetch 实现 LLMAdapter，二者复用同一套 message/sense adapter（结构同形，鸭子类型解析）。

### bigmodel provider（[bigmodel.ts](../../src/agent/provider/bigmodel.ts)）

智谱 BigModel，OpenAI 兼容协议，base_url 默认 `https://open.bigmodel.cn/api/paas/v4/`（可配，也能指向聚合端点）。LLMAdapter 用 fetch 基座：`chat` 走 `jsonRequest`、`chatStream` 走 `streamSSE`，请求体 `{model, messages, stream, tools?, reasoning_effort?}`；message/sense adapter 复用 openaiCompat（自动获得 `reasoning_content` 解析 + image 多模态 + tool_calls）。注册名 `"bigmodel"`。

### anthropic provider（[anthropic.ts](../../src/agent/provider/anthropic.ts)）

Anthropic Messages API（endpoint `/messages`，版本前缀如 `/v1`、`/v4` 由用户在 `cfg.url` 自己负责，与 openai 模式对齐），原生 fetch 实现（遵项目扩展点约定，不引 `@anthropic-ai/sdk`）。message/sense adapter 不可复用 openaiCompat（Anthropic 用 content-block + 顶层 `system` + tool_use/input 对象），需自写。LLMAdapter 也**不复用** fetchBase 的 `jsonRequest/streamSSE`（硬编码 `/chat/completions`+Bearer+`[DONE]`），需写私有 `anthropicFetch`/`anthropicStreamSSE`。

**请求侧（[anthropic.ts buildThinkingParam](../../src/agent/provider/anthropic.ts)）：**

```ts
buildThinkingParam(level: ThinkingLevel | undefined): Record<string, unknown> {
  switch (level) {
    case undefined: case 'off': return {}
    case 'on': return { thinking: { type: 'adaptive' } }
    case 'low': case 'medium': case 'high':
      return { thinking: { type: 'adaptive' }, output_config: { effort: level } }
  }
}
```

`max_tokens` 硬常量 `16384`（Anthropic 强制必填，钩子可覆盖）。**`PreLLMRequest` hook 是覆盖逃生口**——适配怪异端点的 thinking 字段（详见 [hooks.md](./hooks.md)）。

**请求体组装（[anthropic.ts chat](../../src/agent/provider/anthropic.ts)）：**

```ts
let body: AnthropicBody = {
  model, max_tokens: 16384,
  ...(messages.system && { system: messages.system }),  // buildMessages 抽出的 system
  messages: messages.messages,                            // 只剩 user/assistant
  ...(sensesAsAnthropic.length && { tools: sensesAsAnthropic }),
  ...buildThinkingParam(options?.thinking),
}
body = await applyPreLLMRequest(body, options)  // ← hook 改 body 或抛 ClassifiedError
```

**响应解析（Message Adapter）：**

```ts
content(raw) = raw.content.filter(b => b.type === 'text').map(b => b.text).join('')
thinking(raw) = raw.content.filter(b => b.type === 'thinking').map(b => b.thinking).join('') // 空 → undefined
extractStreamDelta(chunk) = chunk.delta.type === 'text_delta' ? chunk.delta.text : ''
extractStreamThinking(chunk) = chunk.delta.type === 'thinking_delta' ? chunk.delta.thinking : undefined
```

**buildMessages 返回元组（Anthropic 特例）：**

```ts
buildMessages(history, attachments?): { system: string | null, messages: AnthropicMsg[] }
// 而非 TMessage[]（与 OpenAI 兼容协议差异）
```

抽取 `role:'system'` → 顶层 `system`（多条 `\n\n` 拼接）；`ensureAlternatingUserFirst` 处理 role 归一 + 强制首条 user + 合并连续同 role；case 分发：

| LLMResponse | Anthropic 消息 |
|-------------|---------------|
| `sense` | `{role:'user', content:[{type:'tool_result', tool_use_id, content: replace.state?replace.content:m.content}]}` |
| `assistant`+senseCalls | `[{thinking?}, {text?}, {tool_use,id,name,input:JSON.parse(arguments)}]`（thinking 必须在 text/tool_use 之前） |
| `assistant` 无 senseCalls | `[{thinking?}, {text?}]`（全空时 `[{text:''}]` 兜底） |
| `user`+image attachments | `[{text}, {image, source:{base64,media_type,data}}]`（仅 image/；video/audio 由 chat.ts enrichMediaInputs 旧路径文本转写） |
| 普通 user | `[{text}]` |

**Sense Adapter 流式 delta 对接（与 SenseCallAssembler 天然兼容）：**

```ts
extractSenseCallDeltas(chunk):
  content_block_start(tool_use) → [{ index, id, name, arguments: '' }]   // 播种
  content_block_delta(input_json_delta) → [{ index, id: 'sense-${i}', arguments: partial_json }]  // 累加
```

`SenseCallAssembler.push` 按 `index` 累积、`id`/`name` 取首非空不覆盖 → 与 OpenAI 路径等价。

**SSE 解析（anthropicStreamSSE）：** 仿 `fetchBase.ts:210-270` 行缓冲骨架，改：
- endpoint `/messages`（版本前缀由用户在 `cfg.url` 提供）
- headers `x-api-key` + `anthropic-version: 2023-06-01` + `Accept: text/event-stream`
- 终止条件 `message_stop`（而非 `[DONE]`）
- `finally` 必跑 `controller.abort() + reader.cancel()`（对接 `generator.throw()` abort）

**复用：** `assertChatOptions` / `brainHttpError` / `brainNetworkError` / `readErrorSnippet`（fetchBase provider 无关部分）+ `acquireRpm`（openaiCompat）+ `buildBaseSenseFunction`（compiler/utils）。

**注册名 `"anthropic"`。**

### Anthropic 的 PreLLMRequest hook（[hooks.md](./hooks.md)）

anthropic provider 在 body 构造完成后、fetch 调用前自动 `dispatch('PreLLMRequest', ...)`。handler stdin 喂 `{event, payload: {provider, model, url, thinking, stream, body}, ctx}`，stdout 返回 `{body?: <new>, decision?: 'block', reason?}` 改写 body 或阻断。这是 anthropic provider 适配怪异「anthropic 兼容」端点的标准机制——详见 [hooks.md](./hooks.md)。
