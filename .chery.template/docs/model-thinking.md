# model-thinking.yaml — 模型思考档位映射

> 模板文件：`.chery.template/model-thinking.yaml` ｜ 运行位置：`.chery/model-thinking.yaml`
> 加载入口：[src/utils/modelThinking.ts](../../src/utils/modelThinking.ts)
> 相关文档：[../../docs/utils/config.md](../../docs/utils/config.md#modelthinkingts--模型档位映射)

## 用途

声明模型 → 支持的思考强度档位（`ThinkingLevel`）映射。前端 BrainCard 在 model 字段变化时调用 `utils.thinkingLevels` RPC，渲染「深度思考」旋钮；后端 provider 在构造请求时按该档位子集校验。

## 顶层结构

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `models` | array | ✅ | 模型条目数组；按声明顺序匹配，**先命中先用** |

## models[]. 字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `aliases` | string[] | ✅ | 模型名列表（完整名或前缀；含 `"*"` 表示通配兜底） |
| `thinking` | enum[] | ✅ | 该模型支持的 `ThinkingLevel` 子集 |

**匹配顺序（src/utils/modelThinking.ts `resolveThinkingLevels`）：**

1. **精确匹配** — model 名与某 alias 完全相等
2. **最长前缀匹配** — model 名以某 alias 开头（取最长的）
3. **通配兜底** — 命中 `aliases: ["*"]`
4. **未命中** — 后端兜底返回 `["off", "on"]`

## thinking 档位（ThinkingLevel 枚举）

定义于 [src/core/llm/adapter.ts](../../src/core/llm/adapter.ts)：

| 档位 | 含义 | provider 映射 |
|------|------|---------------|
| `off` | 关闭 | 省略 thinking 参数 |
| `on` | 开关型模型的「由服务端决定」 | OpenAI 不传 `reasoning_effort` / Anthropic `thinking:{type:"adaptive"}` |
| `low` | 低强度 | OpenAI `reasoning_effort:"low"` / Anthropic `output_config.effort:"low"` |
| `medium` | 中强度 | OpenAI `reasoning_effort:"medium"` / Anthropic `output_config.effort:"medium"` |
| `high` | 高强度 | OpenAI `reasoning_effort:"high"` / Anthropic `output_config.effort:"high"` |

## 档位选择规则（最小化）

- 支持 reasoning_effort **全档**的推理模型：列 `[off, low, medium, high]`（**不列 `on`**——已提供显式强度档位时「由模型决定」无独立语义）
- **仅支持开关**的模型（无强度概念）：列 `[off, on]`
- 未配置 / 未命中：后端兜底 `["off", "on"]`

## 已配置模型清单

| 模型系列 | 档位 | 备注 |
|----------|------|------|
| 智谱 GLM（glm-5.2 / glm-5 / glm-4.6 / glm-4-plus / glm-4） | `[off, low, medium, high]` | OpenAI 兼容协议，`reasoning_effort` 全 4 档 |
| LongCat-Flash-Thinking / LongCat-Flash-Thinking-2601 | `[off, on]` | 专属思考模型，仅开关 |
| 豆包 doubao（doubao2.0-pro / doubao-pro / doubao-lite） | `[off, low, medium, high]` | |
| DeepSeek（deepseek-r1 / deepseek-reasoner / deepseek-v3） | `[off, low, medium, high]` | |
| OpenAI o1 系列（o1 / o1-mini / o1-preview / o3 / o3-mini / o4-mini） | `[off, low, medium, high]` | |
| Anthropic Claude 系列（claude-fable-5 / claude-mythos-5 / claude-opus-4-{8,7,6,5,1,0} / claude-sonnet-{5,4-6,4-5,4-0} / claude-haiku-4-5） | `[off, on, low, medium, high]` | `on` 走 adaptive 自适应；`low/medium/high` 走 effort |
| `"*"`（通配） | `[off, on]` | 未列出的模型默认仅暴露开关两档 |

## 示例

**新增条目（某模型推理档位全 4 档）：**

```yaml
models:
  - aliases: [my-new-model]
    thinking: [off, low, medium, high]
```

**新增「开关型」模型：**

```yaml
models:
  - aliases: [my-thinking-only-model]
    thinking: [off, on]
```

**别名（多 model 共用档位）：**

```yaml
models:
  - aliases: [foo, foo-mini, foo-pro]
    thinking: [off, low, medium, high]
```

**前缀匹配（无需逐个列举）：**

```yaml
models:
  - aliases: [claude-]                # 匹配 claude- 开头的所有模型
    thinking: [off, on, low, medium, high]
```

## RPC 暴露

```ts
utils.thinkingLevels({ models: string[] }) → { levels: Record<string, ThinkingLevel[]> }
```

前端 BrainCard 在 model 字段变化时调用，渲染「深度思考」选择器。未在 RPC 返回中的 model 后端兜底为 `["off", "on"]`。

## 关联

- 模型档位枚举：[src/core/llm/adapter.ts](../../src/core/llm/adapter.ts)
- Anthropic thinking 适配：[docs/agent/hooks.md](../../docs/agent/hooks.md)（通过 `PreLLMRequest` 钩子按端点改写）
- Provider 文档：[docs/agent/provider.md](../../docs/agent/provider.md)