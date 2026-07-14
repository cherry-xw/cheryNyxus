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
| [index.ts](../../src/agent/provider/index.ts) | `registerBuiltinProviders()`：幂等注册 openai/ollama/mock/bigmodel |
| [openai.ts](../../src/agent/provider/openai.ts) | OpenAI（含兼容服务）三件套，含 RPM 限流、`reasoning_effort` 映射、`reasoning_content` 提取、`strict:true` |
| [ollama.ts](../../src/agent/provider/ollama.ts) | Ollama 三件套，含 `tool_calls` 处理与流式不可靠警告 |
| [mock.ts](../../src/agent/provider/mock.ts) | 脚本回放 provider（离线测试），按 LLM 调用序逐条回放 |
| [bigmodel.ts](../../src/agent/provider/bigmodel.ts) | 智谱 BigModel 三件套（fetch 实现），`reasoning_effort` 映射、`reasoning_content` 提取、image 多模态 |

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

### Provider 能力差异

| 维度 | openai | ollama | mock | bigmodel |
|------|--------|--------|------|----------|
| thinking 请求参数 | `reasoning_effort:level`（off 省略） | 无（不传） | N/A | `reasoning_effort:level`（同 openai） |
| thinking 响应字段 | `reasoning_content` | `message.thinking` | `thinking` | `reasoning_content` |
| `buildSenses` 加 `strict:true` | ✓ | ✗ | ✗ | ✓ |
| tool_call.id | 有（`call_xxx`） | 无（randomUUID 占位） | 缺省 randomUUID | 有 |
| 流式 tool_call 稳定 | 稳定 | 不稳定（P1-2） | 稳定（自拆 delta） | 稳定（OpenAI 协议） |
| RPM 限流 | ✓（`brain.rpm`） | ✗ | ✗ | ✓（`brain.rpm`） |
| 真实网络 | 是 | 是 | 否（脚本回放） | 是 |
| buildMessages 把 `sense` 转 `tool` result | ✓（带 `tool_call_id`） | ✓（仅 role+content） | ✗（直接透传 LLMResponse） | ✓（同 openai） |
| HTTP 实现 | openai SDK | ollama SDK | 脚本回放 | 原生 fetch（fetchBase） |

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

- `streamSSE(url, body, headers): AsyncGenerator<Record<string,unknown>>` —— SSE 流式：内部自建 `AbortController`、`getReader()` + `TextDecoder` 跨 chunk 行缓冲、按 `\n` 切行、跳过空行/`:` 注释心跳、剥离 `data:` 前缀、`[DONE]` 主动结束；**finally 必跑 `controller.abort()` + `reader.cancel()`**（对接现有 abort 机制：`compose.ts` 的 `generator.throw()` → for-await 释放 → finally 切断 HTTP）。
- `jsonRequest(url, body, headers): Promise<Record<string,unknown>>` —— 非流式。
- `assertChatOptions(options)` —— model/url/key 校验 + `$ENV` 占位符检测（从 openai.ts 抽出，共用）。
- 错误封装：`!res.ok` → `throwUserFacing("llm.fetch.http", ...)`，message 避开 retry 关键词；网络错误 `llm.fetch.network`。

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
