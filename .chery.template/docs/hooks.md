# hooks — 事件驱动扩展

> 模板目录：`.chery.template/hooks/` ｜ 运行位置：`.chery/hooks/`
> 加载入口：[src/agent/hooks/](../../src/agent/hooks/)（registry / dispatch / matcher）
> 详细机制：[../../docs/agent/hooks.md](../../docs/agent/hooks.md)

## 用途

仿 Claude Code hooks 风格的事件驱动扩展机制。在 LLM 调用 / 工具执行 / 会话生命周期等关键点触发 shell handler，让用户在不改框架代码的前提下：
- 改写 LLM 请求体（解决 anthropic 兼容端点 thinking 参数私有 schema 适配）
- 阻断 LLM 调用或工具执行
- 注入额外上下文

**handler 仅支持 shell（stdin JSON / stdout JSON）；不支持 `prompt` / `agent` / `http` / `mcp_tool` 类型。**

## 文件清单

| 文件 | 职责 |
|------|------|
| [../hooks/hooks.json](../hooks/hooks.json) | 事件 → handler 映射（事件名作为顶层 key） |
| [../hooks/anthropic-thinking.sh](../hooks/anthropic-thinking.sh) | 示例 handler：anthropic 官方端点 thinking 透传；其它端点改写为私有 schema |

## hooks.json 字段

### 顶层字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `_comment` | string | ❌ | 全局注释（仅文档作用，运行期忽略） |
| `_events` | object | ❌ | 事件说明（仅文档作用） |
| `<EventName>` | array | ✅ | 事件名（`PreLLMRequest` / `PreToolUse` / `SessionStart` / `Stop` 等）→ handler 对象数组 |

### 顶层 key：事件名

**当前实现状态**（[src/agent/hooks/dispatch.ts](../../src/agent/hooks/dispatch.ts)）：

| 事件 | 状态 | input | output / 决策 |
|------|------|-------|--------------|
| `SessionStart` | stub | `{chatId, brain}` | `{additionalContext?}` |
| `SessionEnd` | stub | `{chatId, reason}` | `{}` |
| `UserPromptSubmit` | stub | `{chatId, prompt, role}` | `{decision?, reason?, additionalContext?}` |
| **`PreLLMRequest`** | **完整** | `{provider, model, url, thinking, stream, body}` | `{body?, decision?, reason?, metadata?}` |
| `PostLLMResponse` | stub | `{provider, model, content, thinking, senseCalls}` | `{content?, thinking?, senseCalls?, additionalContext?}` |
| `PreToolUse` | stub | `{name, args, chatId}` | `{decision?, updatedInput?, reason?}` |
| `PostToolUse` | stub | `{name, args, result, hash, chatId}` | `{decision?, reason?, additionalContext?}` |
| `Stop` | stub | `{chatId, message, stopReason}` | `{decision?, reason?, additionalContext?}` |
| `PreCompact` | stub | `{chatId, tokenCount}` | `{decision?, reason?}` |
| `PostCompact` | stub | `{chatId, summary, tokenCount}` | `{}` |

> stub = dispatcher 触发后 `logger.event` 记录事件，不调 handler；调用方代码已预留。

### handler 对象字段

| 字段 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `_comment` | string | ❌ | — | 注释（仅文档） |
| `matcher` | string | ❌ | `*`（匹配全部） | 按 `payload` 中某字段过滤（详见 matcher 规则） |
| `if` | string | ❌ | — | jq-lite 谓词（基于 `{event, payload, ctx}`），如 `payload.thinking == 'high'` |
| `command` | string | ✅ | — | shell 命令（支持 `${CHERY_DIR}` 环境变量占位） |
| `timeout` | number (s) | ❌ | 10 | handler 超时 |

### matcher 规则（仿 Claude Code）

- 仅含字母数字 / `_` / `-` / `,` / `|` / 空格 → **精确字符串**或 `|` / `,` 分隔的字符串集合
- 含其它字符 → **JS 正则**（unanchored）
- 省略或 `*` → 匹配全部

### `if` 谓词（jq-lite 子集）

仅支持：
- `field == "value"` / `field != "value"`
- `field`（truthy / falsy）
- `field1 == field2`

访问 `{event, payload, ctx}` 嵌套字段。**不支持**算术 / 函数调用 / 复杂表达式。

## Handler 进程契约

**stdin**（框架写入）：
```json
{
  "event": "PreLLMRequest",
  "payload": { "provider": "...", "model": "...", "url": "...", "thinking": "...", "stream": true, "body": { ... } },
  "ctx": { "brain": "..." }
}
```

**stdout**（handler 写入，exit 0）：
```json
{ "body": { ... }, "decision": "block|allow", "reason": "...", "metadata": { ... } }
```

- 任意字段缺失视为未设
- `body` → 替换 `payload.body`
- `decision: "block"` → 抛 `ClassifiedError(category:"validation")` 阻断
- `additionalContext` → 注入 chat 上下文
- `metadata` → 仅记录到日志，不修改 body

**退出码：**

| code | 含义 |
|------|------|
| 0 | 解析 stdout JSON 为决策 |
| 2 | 阻断式错误（PreLLMRequest / PreToolUse / PreCompact 阻断对应动作；stderr 喂回 LLM 或用户） |
| 其它非零 | 非阻断错误，记 `logger.event("hook.failed",...)`，**继续下一个 handler** |

## 示例

### 模板 hooks.json

```jsonc
{
  "_comment": "事件驱动 hooks 配置",
  "PreLLMRequest": [
    {
      "matcher": "anthropic",
      "if": "payload.url == 'https://api.anthropic.com'",
      "command": "${CHERY_DIR}/.chery/hooks/anthropic-thinking.sh",
      "timeout": 10
    },
    {
      "_comment": "通用兜底：审计日志",
      "command": "echo '{}'"
    }
  ]
}
```

### 模板 anthropic-thinking.sh

按 `URL` 判定：官方端点 → body 透传；其它端点 → 按档位改写 `thinking` 字段为各端点私有 schema（`{type:"enabled", budget_tokens:N}`）。详见 [../hooks/anthropic-thinking.sh](../hooks/anthropic-thinking.sh)。

## Brain 级覆盖

`BrainConfig.hooks?: string`（相对 `.chery/`）指向 brain-specific `hooks.json`，事件 handler 与全局**合并**：
- 顺序：全局在前，brain 级在后
- 同事件下 brain 级 handler **追加**在全局 handler 之后
- brain 级决策**覆盖**全局决策

```yaml
llm:
  brain:
    anthropic_main:
      hooks: hooks/anthropic-main.json    # 相对 .chery/
```

## Dispatch 流程

```
dispatch(event, payload, ctx)
  ├─ registry 查 event → 合并全局 + brain 级 handler 列表
  ├─ matcher 过滤 → if 谓词过滤
  ├─ 顺序执行 handler（不并发，避免 stdout 竞态）：
  │    ├─ spawn sh -c command
  │    ├─ stdin 写 {event, payload, ctx} JSON
  │    ├─ 解析 stdout JSON（catch 失败，跳过）
  │    └─ 应用决策（body 替换 / block 阻断 / 注入上下文）
  └─ 任一异常 → log + 继续下一个
```

## 加载策略：mtime 重读

- `bootstrapAgentRuntime` 启动期读 `.chery/hooks/hooks.json` + 各 brain 级 hooks.json，校验 schema
- **handler 进程不预热**（仿 mock 哲学：改 hooks.json 免重启，下次 dispatch 自动 re-read）
- `.chery/hooks/*.sh` 按需 `cat` / `exec`；非闭包，不需缓存

## 安全边界

- **信任边界**：`.chery/hooks/` 与 `.chery/senses/`、`installSkill` staging 同级——本地用户配置，可信
- **无沙箱**：handler 进程以主进程用户权限执行，可调任意 global（process / fs / network）——文档明示
- **凭据不喂给 handler**：dispatcher **不**把 `key` / `token` 写入 stdin；handler 自读环境变量
- **pathGuard**：`.chery/hooks/` 受 pathGuard 保护；如需工具通过 hooks 写 `.chery/hooks/`，需手工加 `GUARD_EXEMPT` 豁免

## 关联

- 详细契约：[../../docs/agent/hooks.md](../../docs/agent/hooks.md)
- Anthropic provider：[docs/agent/provider.md](../../docs/agent/provider.md)
- 模板示例：[../hooks/anthropic-thinking.sh](../hooks/anthropic-thinking.sh)