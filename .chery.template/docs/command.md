# command — 用户指令（Command）

> 模板目录：`.chery.template/command/` ｜ 运行位置：`.chery/command/`
> 详细文档：[../../docs/system-prompt.md](../../docs/system-prompt.md)

## 用途

存放用户可通过 `[[command:/名称]]` 标记触发的内置指令。指令由用户在发送窗口明确选择（如 `/compact`），token 不出现在默认 system prompt 中，系统按需加载。

## 目录结构

```
command/
  <command-name>.md              # 指令定义（Markdown，含 frontmatter）
```

## 文件结构

```markdown
---
name: <command-name>            # 指令标识（在 [[command:/name]] 中引用）
description: <一句话描述>        # 出现在前端指令列表
---

# 指令正文

[具体指令内容，可多段]
```

## 字段参考表

### Frontmatter

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 指令标识（在 `[[command:/名称]]` 中引用） |
| `description` | string | ✅ | 一句话描述（前端指令选择器展示） |

### 正文

指令的完整内容。系统按需加载（不在默认 system prompt），仅在用户触发时注入。

## 模板示例（compact）

[../command/compact.md](../command/compact.md)：整理当前对话为后续继续工作的上下文摘要。触发后 LLM 仅以纯文本回复（禁止任何工具调用），按指定结构生成 `<analysis>` + `<summary>` 块。

**触发方式：** 用户在消息中写 `[[command:/compact]]`。

**处理流程：**
1. system.md「用户消息中的指令标记」段识别 `[[command:/compact]]`
2. 加载 `command/compact.md` 正文注入当前对话
3. LLM 按指令要求生成纯文本摘要

## 编写建议

- **description 简洁**：用户在前端选择器看到这一行
- **正文自包含**：指令被加载时上下文可能不完整，正文应自带必要说明
- **明确边界**：禁止动作（如「不要调用工具」）写在最前
- **输出格式**：明确要求输出结构（如「必须含 X 块」）

## 内置指令清单

| 指令 | 作用 | 模板 |
|------|------|------|
| `/compact` | 整理当前对话为上下文摘要 | [../command/compact.md](../command/compact.md) |

> 内置指令在 `system.md` 中以「`[[command:/名称]]`」格式识别；新指令需在 system.md「用户消息中的指令标记」段补充说明。

## 注意事项

- 修改指令**无需重启**：下一次触发按需加载
- `name` 与文件名不一致 → 加载失败
- 指令正文可被 LLM 完整读取，注意不要包含敏感信息（API Key、token 等）

## 关联

- 触发机制：[../prompt/system.md](../prompt/system.md)（「用户消息中的指令标记」段）
- 模板示例：[../command/compact.md](../command/compact.md)
- 提示词系统：[../../docs/system-prompt.md](../../docs/system-prompt.md)