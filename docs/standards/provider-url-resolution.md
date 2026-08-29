# Provider URL 端点拼接与解析规范 v1.0

> **状态**：强制执行。
> **适用范围**：`src/agent/provider/**`（provider 实现）、`src/core/llm/urlPattern.ts`（注册表）、正式 chat / `utils.models` / `utils.testConnection` 三处 URL 行为。
> **实现细节**：注册值与拼接实现见 [docs/agent/provider.md](../agent/provider.md)「URL 解析与端点拼接」；注册表代码见 `src/core/llm/urlPattern.ts`，统一入口见 `src/agent/provider/fetchBase.ts` 的 `resolveProviderUrl` / `buildEndpointUrl`。

## 0. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| v1.0 | 2026-08-26 | 从记忆落为强制规范：URL 端点是注册 provider 必须提供的能力、统一入口、版本段交用户、fullUrl 不拼接 |
| v1.1 | 2026-08-28 | §4 新增 `/models` openai 兼容协议常量豁免：utils.models anthropic 双尝试回退的拼接路径（buildEndpointUrl 直拼，仅 utils.models，三处一致性不变） |

## 1. 核心原则

1. **URL 端点是注册 provider 必须提供的能力之一**：每个 provider 实现时，与 `registerLLMAdapter` 并列调用 `registerProviderUrlPattern`（`src/core/llm/urlPattern.ts`），声明 `chat` / `models` 两种 kind 的端点模式。
2. **URL 拼接一律经统一入口 `resolveProviderUrl`**（`src/agent/provider/fetchBase.ts`），禁止在各 adapter 内自行拼 URL。
3. **三处行为必须一致**：正式 chat、`utils.models` 拉取、`utils.testConnection` 均走同一入口，防止补全逻辑漂移——历史 404 bug 的根因正是 openai/anthropic/bigmodel/utils.models 各有一套补全。
4. **版本段（`/v1` 等）由用户填写**：后端不自动补版本段，只拼端点。

## 2. 端点模式三态（`ProviderUrlPattern.chatEndpoint` / `modelsEndpoint`）

| 声明值 | 含义 | 拼接行为 |
| --- | --- | --- |
| `undefined` | host 模式（未注册，或该 kind 不支持） | URL 原样去尾斜杠，**不拼接** |
| `''` | 不拼端点，base 原样 | 端点由 openai SDK 自拼；**版本段由用户填写** |
| `'/xxx'` | 拼端点 | `base + endpoint`（如 `/messages`、`/chat/completions`） |

## 3. `fullUrl` 语义

- `fullUrl=true` 时**完全不拼接**（仅去尾斜杠），请求 URL 即用户填写的原值，由用户完全自负责——填完整 URL 时须自带全部路径（含 `/messages`、`/models` 等端点）。
- 注意已知边界：anthropic 勾选 fullUrl 后，「刷新模型」请求地址与 chat 的 `…/v1/messages` 同用一个 `url` 字段不可兼得，按需取舍。
- `fullUrl` 经 `BrainConfig` → `LLMOptions` → provider 逐层透传；前端 BrainCard「完整 URL」勾选与 yaml 同步。

## 4. 例外与协议常量

- **ollama 类 host 模式 provider 可不注册**：未注册 → `getProviderUrlPattern` 返回 undefined → host 模式不拼接。
- **`/chat/completions` 是 openai 兼容协议常量**：`jsonRequest` / `streamSSE` 内的该端点不收敛、不走注册表；一致性由单测锁死（`test/agent/provider/fetchBase.test.ts`）。
- **`/models` 是 utils.models anthropic 双尝试的 openai 兼容协议常量**（2026-08-28）：主尝试（Anthropic 原生 `/models?limit=1000`）无产出且未勾选 `fullUrl` 时，回退请求 `GET {base}/models`（Bearer）由 `buildEndpointUrl` 直拼，不走注册表——与 `/chat/completions` 同款豁免；回退仅存在于 `utils.models`，chat / `utils.testConnection` 行为不变，三处一致性不受影响。
- **地址拼接只做简单拼接**（最多对结尾 `/` 归一），不做花哨兼容判断。

## 5. 兼容性注意（2026-08 简化）

不再自动补版本段：url 未含版本段的旧配置会失效（如 openai 填根地址 `https://x:11411` 未勾选会请求到 `https://x:11411/chat/completions` 而非 `…/v1/chat/completions`），需在 url 中补上版本段（如 `https://x:11411/v1`）。前端地址输入框 placeholder 已注明此约定。

## 6. Review 清单

- [ ] 新增/修改 provider 是否声明了 `chat` / `models` 两 kind 的端点模式（或明确为 host 模式不注册）？
- [ ] 是否有绕过 `resolveProviderUrl` 的自行 URL 拼接？
- [ ] 正式 chat、`utils.models`、`utils.testConnection` 三处行为是否一致？
- [ ] 是否理解「版本段交用户、后端只拼端点」与 `fullUrl` 完全不拼接的语义？
