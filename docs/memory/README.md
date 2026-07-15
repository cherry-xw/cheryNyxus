# 项目记忆模块（memory）

> 双层 Markdown 记忆系统：global（跨 chat 共享，用户层面的习惯/事实/准则）+ workspace（per chat / per 项目的行为规范）。主 agent 通过 `memory_manage` sense 工具管理，AI 写记忆时显式指定 `scope`。

## 职责

- 管理两层记忆的增删改查 + 淘汰归档（互相独立、互不干扰）
- global 层隔离所有 chat 共享；workspace 层按 chat 维度隔离
- System prompt 同时注入两层活跃记忆摘要（`<memory layer="global">` + `<memory layer="workspace">`）
- 主 agent 硬编码注入 memory_manage sense；子 agent 排除（但 system prompt 中看到的内容不变）

## 双层模型

```
┌─────────────────────────────────────────────────────────┐
│ global 层（所有 chat 共享；管用户习惯/事实/准则）         │
│   路径：.chery/memory/                                  │
│   结构：main.md（活跃索引） + N 个 *.md（活跃条目，平铺）│
│         + history/ 目录（淘汰归档）                       │
│   默认上限：30 条 / 500 字                               │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│ workspace 层（per 项目；PresetConfig.workspace 设置时）   │
│   路径：.chery/workspace/<sha256(path)[:12]>/memory/    │
│   结构：main.md（活跃索引） + N 个 *.md（活跃条目，平铺）│
│         + history/ 目录（淘汰归档）                       │
│   默认上限：15 条 / 500 字                               │
│   无 workspace 的 chat：scope="workspace" 被拒绝         │
└─────────────────────────────────────────────────────────┘
```

两层的活跃条数、单条字数限制互相独立，配置在 `memory.global.*` / `memory.workspace.*`。任何 chat（无论有无 workspace）都可见 global 层；只有配置了 `PresetConfig.workspace` 的 chat 才能读写 workspace 层。写入时 AI 通过 `memory_manage` sense 的 `scope` 参数显式选择 `global` 或 `workspace`。

> 历史归档单独放在 `<root>/history/` 子目录，文件布局 `main.md`（历史索引） + `*.md`（历史详情，平铺）。

## 文件清单

| 文件 | 职责 |
|------|------|
| `src/memory/types.ts` | 类型定义：Memory / HistoryEntry / Frontmatter / IndexEntry；导出 `MemoryScope` |
| `src/memory/path.ts` | 路径计算：scope=global → `.chery/memory/`；scope=workspace + workspace → `.chery/workspace/<hash>/memory/`；scope=workspace + 无 → 抛错 |
| `src/memory/store.ts` | MD 文件读写：frontmatter 解析/序列化 + main.md 索引 + 平铺 *.md + history/ 归档 |
| `src/memory/manager.ts` | 业务逻辑：add/remove/update/list/history + 按 scope 独立限制淘汰 |
| `src/memory/index.ts` | 统一导出（含 `MemoryScope` 类型） |

## 存储结构

```
# global 层（所有 chat 共享）
.chery/memory/
├── main.md                ← 活跃汇总索引
├── feedback-prefers-tabs.md
├── user-no-emoji.md
├── ...（最多 max_count 条；平铺无子目录）
└── history/
    ├── main.md            ← 历史汇总索引
    └── *.md               ← 历史详情（含替换元数据；平铺）

# workspace 层（PresetConfig.workspace 存在时）
.chery/workspace/<sha256(path)[:12]>/memory/
├── main.md
├── *.md
└── history/
    ├── main.md
    └── *.md
```

两层目录各自保留 `main.md` + `*.md` + `history/` 三件套，互不干扰；活跃条目和历史条目分目录存放。

## 记忆格式

### 活跃记忆（<root>/<name>.md）

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

注：`scope` **不写进 frontmatter**，由写入时的目录位置决定；活跃条目与 `<root>/main.md` 索引同级（不嵌套子目录）。

### 历史记忆（<root>/history/<name>.md）

在活跃基础上增加淘汰元数据：

```yaml
metadata:
  node_type: memory
  type: fact
  replaced_at: "2026-07-14T11:00:00Z"
  replaced_reason: "被新记忆'xxx'替换，因信息已过时"
  replaced_by: "new-memory-name"
```

### 汇总索引（<root>/main.md）

```markdown
# Memory Index

- [Doc-First 强制准则](doc-first-mandatory.md) — 任何任务执行前，先修改文档
```

历史索引同样格式，存放在 `<root>/history/main.md`。

## 配置

```yaml
# .chery/config.yaml
memory:
  global:                       # 所有 chat 共享
    max_count: 30               # 活跃记忆最大条数（超限触发淘汰）
    max_chars: 500              # 单条记忆正文字数上限
  workspace:                    # per chat / per 项目
    max_count: 15
    max_chars: 500
```

缺省值：`global { max_count=30, max_chars=500 }`、`workspace { max_count=15, max_chars=500 }`。两层字段全部 optional，未填则用默认。

## 核心导出

### 类型

- `Memory` — 活跃记忆完整数据（name/description/type/content/originSessionId）
- `HistoryEntry` — 历史记忆（+ replacedAt/replacedReason/replacedBy）
- `MemoryType` — 分类：`feedback | fact | instruction | decision | reference`
- `MemoryScope` — 层标识：`"global" | "workspace"`（默认 `"workspace"`）

### 管理器函数

| 函数 | 说明 |
|------|------|
| `addMemory(params)` | 添加记忆；params 新增 `scope?: MemoryScope`，达该层上限时必须指定 `replaceTarget + replaceReason` |
| `removeMemory(name, reason, workspace?, scope?)` | 删除记忆（移入该层历史） |
| `updateMemory(params)` | params 新增 `scope?: MemoryScope`，按该层 `max_chars` 校验 |
| `listMemories(workspace?, scope?)` | 列出该层活跃记忆 |
| `listHistories(workspace?, scope?)` | 列出该层历史记忆 |

### 路径函数

| 函数 | 说明 |
|------|------|
| `getMemoryRootDir(workspace?, scope?)` | 记忆根目录；`scope="global"` → `.chery/memory/`；`scope="workspace" + workspace` → `.chery/workspace/<hash>/memory/`；`scope="workspace" + 无` → 抛错（业务层拒绝非 workspace chat 调 scope=workspace） |
| `getMemoriesDir(workspace?, scope?)` | 根目录自身（活跃条目平铺，已废弃命名，保留仅为兼容；内部统一调用 `getMemoryRootDir`） |
| `getMemoryIndexPath(workspace?, scope?)` | `<root>/main.md` |
| `getHistoryDir(workspace?, scope?)` | `<root>/history/` |
| `getHistoryMemoriesDir(workspace?, scope?)` | `<root>/history/`（历史详情平铺在此） |
| `getHistoryIndexPath(workspace?, scope?)` | `<root>/history/main.md` |
| `hashWorkspacePath(path)` | SHA256 前 12 位 |

## 关键流程

### memory_manage sense

`src/agent/sense/memory.ts` — 主 agent 硬编码注入的 sense 工具。

**必填参数：** `scope: "global" | "workspace"`（AI 显式选择写入层）。

**操作：**
- `add` — `scope` + 添加新记忆（达该层上限时淘汰旧记忆）
- `remove` — `scope` + 删除（移入该层历史）
- `update` — `scope` + 更新内容/描述（按该层 `max_chars` 校验）
- `list` — `scope` + 列出该层活跃记忆
- `history` — `scope` + 列出该层历史记忆

**约束：**
- `scope="workspace"` 仅当 `PresetConfig.workspace` 已配置时可用；handler 检测 `getChatWorkspace(ctx.chatId)===undefined` → 返回错误「当前 chat 未配置 workspace，scope="workspace" 不可用」
- 无 workspace 时该 chat 只能写 `scope="global"`

**workspace 识别：** `scope="workspace"` 时通过 `ctx.chatId → getChatWorkspace(chatId)` 校验是否存在；存在则落 `.chery/workspace/<hash>/memory/`，否则报错。`scope="global"` 时忽略 workspace（指向 `.chery/memory/`）。

**写入语义指引（提示词）：**
- `feedback` / `fact`（用户偏好、通用事实）→ 默认 `scope="global"`
- `instruction` / `decision` / `reference`（项目级约束、决策、外部链接）→ 默认 `scope="workspace"`
- 仍有歧义时由模型判断

- 调用前必须确认 chat 是否配置了 workspace：无 workspace 仅用 `scope="global"`

### System Prompt 注入

`buildFirstSystemPrompt()` 在 `<environment>` 和 `<skills>` 之间同时注入两层（如有内容）：

```
<memory layer="global">
以下是全局活跃记忆（所有 chat 共享，最多 30 条），通过 memory_manage 工具的 scope="global" 管理。
# Memory Index

- [用户偏好 Markdown 标签](user-prefers-tabs.md) — 用户偏好用 tab 缩进展示代码块
</memory>

<memory layer="workspace">
以下是当前 workspace 活跃记忆（最多 15 条），通过 memory_manage 工具的 scope="workspace" 管理。
# Memory Index

- [Doc-First 强制准则](doc-first-mandatory.md) — 任何任务执行前，先修改文档
</memory>
```

两层各自独立读取对应根目录的 `MEMORY.md`；缺一层时省略该块。

**注入时机：** 仅 agent 初始化时一次性注入（`AgentBuilder.init()`），不动态更新。

### 主/子 agent 区分

`RuntimeResolver.resolve()` 接受 `injectMemoryManage` 参数（默认 `true`）。

`service/chat/runtime.ts` 的 `configureRuntime()` 辅助函数通过 `getChat(chatId)?.parent_chat_id` 判定：
- `parent_chat_id` 为空 → 主 agent → `injectMemoryManage = true`
- `parent_chat_id` 存在 → 子 agent → `injectMemoryManage = false`

子 agent 不持有 `memory_manage` 工具，但 system prompt 中依然能看到两层 `<memory>` 段（注入独立于工具注册）。

## 依赖与关联

| 方向 | 模块 | 关系 |
|------|------|------|
| 依赖 | `src/utils/config.ts` | 读取 `config.memory.global.{max_count,max_chars}` + `config.memory.workspace.{max_count,max_chars}` + `config.global.memory_dir` |
| 依赖 | `src/db/chat.ts` | `getChatWorkspace(chatId)` 获取 workspace 路径（仅 `scope="workspace"` 时使用） |
| 被依赖 | `src/agent/sense/memory.ts` | memory_manage sense 调用管理器函数（强制带 scope） |
| 被依赖 | `src/agent/prompt/index.ts` | 同时调用 `readMemoryIndexContent(undefined, "global")` 与 `readMemoryIndexContent(workspace, "workspace")` |
| 被依赖 | `src/agent/runtimeResolver.ts` | 硬编码注入 memory_manage 到主 agent senseTable |

## 扩展点

- **新增记忆分类：** 修改 `MemoryType` 类型 + `MemoryTypeSchema`（memory.ts sense）
- **新增层（如 per-team）：** 在 `MemoryScope` 加值 + `path.ts` 加分支 + config 加对应 `{max_count,max_chars}` + manager `getLimits()` 加分支
- **调整淘汰策略：** 修改 `manager.ts` 的 `addMemory()` 中达上限时的处理逻辑
- **自定义存储格式：** 修改 `store.ts` 的 `parseMd()` / `serializeMd()`
- **动态更新记忆注入：** 需改 middleware 层，每轮重新构建 system prompt
