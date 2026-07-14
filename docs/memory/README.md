# 项目记忆模块（memory）

> 项目级 Markdown 记忆系统：持久化跨会话上下文（决策、约定、反馈等），主 agent 通过 `memory_manage` sense 工具管理。

## 职责

- 管理项目级记忆的增删改查 + 淘汰归档
- workspace 模式隔离不同项目的记忆
- System prompt 注入活跃记忆摘要
- 主 agent 硬编码注入 memory_manage sense；子 agent 排除

## 文件清单

| 文件 | 职责 |
|------|------|
| `src/memory/types.ts` | 类型定义：Memory / HistoryEntry / Frontmatter / IndexEntry |
| `src/memory/path.ts` | 路径计算：workspace hash → `.chery/workspace/<hash>/`；非 workspace → `.chery/memory/` |
| `src/memory/store.ts` | MD 文件读写：frontmatter 解析/序列化 + MEMORY.md 索引 + memories/ + history/ |
| `src/memory/manager.ts` | 业务逻辑：add/remove/update/list/history + 15 条上限淘汰 |
| `src/memory/index.ts` | 统一导出 |

## 存储结构

```
# workspace 模式（PresetConfig.workspace 存在时）
.chery/workspace/<sha256(path)[:12]>/
├── MEMORY.md              ← 活跃记忆汇总索引
├── memories/              ← 活跃记忆详情（每条一个 .md 文件）
│   ├── doc-first-mandatory.md
│   └── ...（最多 max_count 条）
└── history/
    ├── MEMORY.md          ← 历史汇总索引
    └── memories/          ← 历史详情（含替换元数据）

# 非 workspace 模式
.chery/memory/
├── MEMORY.md
├── memories/
└── history/
```

## 记忆格式

### 活跃记忆（memories/<name>.md）

```markdown
---
name: doc-first-mandatory
description: 任何任务执行前必须先修改文档
metadata:
  node_type: memory
  type: feedback
  originSessionId: a684d6ed-...
---

**任何任务执行前，先修改文档。**

正文内容...

**Why:** ...
**How to apply:** ...
```

### 历史记忆（history/memories/<name>.md）

在活跃基础上增加淘汰元数据：

```yaml
metadata:
  node_type: memory
  type: fact
  replaced_at: "2026-07-14T11:00:00Z"
  replaced_reason: "被新记忆'xxx'替换，因信息已过时"
  replaced_by: "new-memory-name"
```

### 汇总索引（MEMORY.md）

```markdown
# Memory Index

- [Doc-First 强制准则](memories/doc-first-mandatory.md) — 任何任务执行前，先修改文档
```

## 配置

```yaml
# .chery/config.yaml
memory:
  max_count: 15    # 活跃记忆最大条数（超限触发淘汰）
  max_chars: 500   # 单条记忆正文字数上限
```

缺省值：`max_count=15`、`max_chars=500`。

## 核心导出

### 类型

- `Memory` — 活跃记忆完整数据（name/description/type/content/originSessionId）
- `HistoryEntry` — 历史记忆（+ replacedAt/replacedReason/replacedBy）
- `MemoryType` — 分类：`feedback | fact | instruction | decision | reference`

### 管理器函数

| 函数 | 说明 |
|------|------|
| `addMemory(params)` | 添加记忆；达上限时必须指定 replaceTarget + replaceReason |
| `removeMemory(name, reason)` | 删除记忆（移入历史） |
| `updateMemory(params)` | 更新记忆内容/描述 |
| `listMemories(workspace?)` | 列出所有活跃记忆 |
| `listHistories(workspace?)` | 列出所有历史记忆 |

### 路径函数

| 函数 | 说明 |
|------|------|
| `getMemoryRootDir(workspace?)` | 记忆根目录 |
| `hashWorkspacePath(path)` | SHA256 前 12 位 |

## 关键流程

### memory_manage sense

`src/agent/sense/memory.ts` — 主 agent 硬编码注入的 sense 工具。

**操作：**
- `add` — 添加新记忆（达上限时淘汰旧记忆）
- `remove` — 删除（移入历史）
- `update` — 更新内容/描述
- `list` — 列出活跃记忆
- `history` — 列出历史记忆

**workspace 识别：** 通过 `ctx.chatId` → `getChatWorkspace(chatId)` 获取当前 chat 的 workspace 路径。

### System Prompt 注入

`buildFirstSystemPrompt()` 在 `<environment>` 和 `<skills>` 之间注入 `<memory>` 段：

```
<memory>
以下是项目活跃记忆（最多 15 条），通过 memory_manage 工具管理。
# Memory Index

- [Doc-First 强制准则](memories/doc-first-mandatory.md) — 任何任务执行前，先修改文档
</memory>
```

**注入时机：** 仅 agent 初始化时一次性注入（`AgentBuilder.init()`），不动态更新。

### 主/子 agent 区分

`RuntimeResolver.resolve()` 接受 `injectMemoryManage` 参数（默认 `true`）。

`service/chat/runtime.ts` 的 `configureRuntime()` 辅助函数通过 `getChat(chatId)?.parent_chat_id` 判定：
- `parent_chat_id` 为空 → 主 agent → `injectMemoryManage = true`
- `parent_chat_id` 存在 → 子 agent → `injectMemoryManage = false`

## 依赖与关联

| 方向 | 模块 | 关系 |
|------|------|------|
| 依赖 | `src/utils/config.ts` | 读取 `config.memory.max_count/max_chars` + `config.global.memory_dir` |
| 依赖 | `src/db/chat.ts` | `getChatWorkspace(chatId)` 获取 workspace 路径 |
| 被依赖 | `src/agent/sense/memory.ts` | memory_manage sense 调用管理器函数 |
| 被依赖 | `src/agent/prompt/index.ts` | `readMemoryIndexContent()` 注入 system prompt |
| 被依赖 | `src/agent/runtimeResolver.ts` | 硬编码注入 memory_manage 到主 agent senseTable |

## 扩展点

- **新增记忆分类：** 修改 `MemoryType` 类型 + `MemoryTypeSchema`（memory.ts sense）
- **调整淘汰策略：** 修改 `manager.ts` 的 `addMemory()` 中达上限时的处理逻辑
- **自定义存储格式：** 修改 `store.ts` 的 `parseMd()` / `serializeMd()`
- **动态更新记忆注入：** 需改 middleware 层，每轮重新构建 system prompt
