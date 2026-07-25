# 项目记忆模块（memory）

> 双层 Markdown 记忆系统：global（跨 chat 共享，用户层面的习惯/偏好/准则）+ workspace（per chat / per 项目的行为规范）。记忆分类对齐 Claude Code 四类闭合（user/feedback/project/reference）。主 agent 通过 `memory_manage` sense 工具管理；curator 角色负责 Extract（每轮提取）/ Dream（定时整理）。

## 职责

- 管理两层记忆的增删改查 + 淘汰归档（互相独立、互不干扰）
- global 层隔离所有 chat 共享；workspace 层按 chat 维度隔离
- System prompt 同时注入两层活跃记忆摘要（`<memory layer="global">` + `<memory layer="workspace">`）+ 漂移防护指引
- 主 agent 硬编码注入 memory_manage sense；子 agent 排除（但 system prompt 中看到的内容不变）
- curator 角色承担 Extract（每轮主 agent done 后后台提取）/ Dream（cron 定时整理）

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
  created_at: "2026-07-25T10:00:00Z"
  originSessionId: a684d6ed-...
---

**任何任务执行前，先修改文档。**

正文内容...

**Why:** ...
**How to apply:** ...
```

注：`scope` **不写进 frontmatter**，由写入时的目录位置决定；活跃条目与 `<root>/main.md` 索引同级（不嵌套子目录）。
`created_at` 为写入时间（ISO），用于漂移防护新鲜度判断（不进 main.md 索引行，保持索引简洁）。

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

- `Memory` — 活跃记忆完整数据（name/description/type/content/createdAt/originSessionId）
- `HistoryEntry` — 历史记忆（+ replacedAt/replacedReason/replacedBy）
- `MemoryType` — 分类（对齐 Claude Code 四类闭合）：`user | feedback | project | reference`
  - **user**：用户角色、目标、专业水平、偏好。避免写可能被视为负面评价的内容
  - **feedback**：用户对工作方式的反馈（纠正 + 认可）。content 必须含 Why + How to apply 结构
  - **project**：项目不可从代码/git 推导的信息（进展/决策/截止日期）。content 必须含 Why + How to apply；相对日期转绝对日期
  - **reference**：外部系统指针（Linear/Grafana/Slack 等），记住"去哪找"而非信息本身
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
- `user` / `feedback`（用户角色/偏好、对工作方式的反馈）→ 默认 `scope="global"`
- `project` / `reference`（项目级约束/决策、外部参考）→ 默认 `scope="workspace"`
- 仍有歧义时由模型判断

- 调用前必须确认 chat 是否配置了 workspace：无 workspace 仅用 `scope="global"`

## 漂移防护（参考 Claude Code 记忆系统）

记忆是观点而非事实——三层递进防护：

1. **使用前验证**（prompt 注入 `<memory>` 段尾）：记忆提及文件路径/函数/flag → 先 `read_file` / `search_codebase` 确认当前存在；与当前代码冲突时信任当前状态，用 `memory_manage` 更新；用户要求「忽略记忆」→ 视 `<memory>` 段为空
2. **时间戳**（工具层）：`created_at` 写入 frontmatter（ISO）；新鲜度判断参考（>1 天的旧记忆应用前验证）
3. **Dream 定期整理**（curator 角色）：cron 定时合并重复 / 删除过时 / 精简索引

**保存约束（即使显式请求也拒绝，prompt 注入 + sense description 双重声明）**：
- 不保存可推导信息（代码模式/架构/文件路径/git 历史/调试配方）——read_file / git log 可查
- 不保存 CLAUDE.md 已有内容、当前对话临时任务状态（用 todo/plan 而非 memory）
- 用户要求保存 PR 列表/活动摘要时，只保存「令人意外或非显而易见」的部分

**保存结构（feedback/project 类必须）**：先规则/事实，再 `**Why:**` 行（原因），再 `**How to apply:**` 行（何时/何地适用）。

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
段尾追加漂移防护指引（使用前验证 / 保存约束 / 保存结构），见「漂移防护」章节。

**注入时机：** 仅 agent 初始化时一次性注入（`AgentBuilder.init()`），不动态更新。

### 主/子 agent 区分

`RuntimeResolver.resolve()` 接受 `injectMemoryManage` 参数（默认 `true`）。

`service/chat/runtime.ts` 的 `configureRuntime()` 辅助函数通过 `getChat(chatId)?.parent_chat_id` 判定：
- `parent_chat_id` 为空 → 主 agent → `injectMemoryManage = true`
- `parent_chat_id` 存在 → 子 agent → `injectMemoryManage = false`

子 agent 不持有 `memory_manage` 工具，但 system prompt 中依然能看到两层 `<memory>` 段（注入独立于工具注册）。

## curator 角色（Extract / Dream）

参考 Claude Code 的 Extract Memories Agent + Auto Dream，cheryClaw 用独立角色 `curator` 承担记忆的产生与维护（不直接处理用户业务任务，只在维护场景被派出）：

| 职责 | 触发 | 实现 |
|------|------|------|
| **Extract**（每轮提取） | 主 agent 一轮 done 后（observer 自然结束） | `src/service/chat/extractTrigger.ts` → `runMaintenanceChat`（子 chat, wake=deferred 不唤主） |
| **Dream**（定期整理） | 「维护」预设 `schedule.cron` 到点 | `src/service/schedule/scheduler.ts` Cron → `runMaintenanceChat`（独立主 chat） |

curator 通过 `memory_manage` sense 写记忆（路径由 sense 内部 scope 参数收敛，无需 housekeeper 的 GUARD_EXEMPT 白名单）。角色 prompt 见 [.chery.template/prompt/curator/curator.md](../../.chery.template/prompt/curator/curator.md)；角色文档见 [docs/agent/curator.md](../agent/curator.md)。

**互斥**：curator Extract prompt 指示「主 agent 本轮已写记忆则跳过」+ 调 `memory_manage list` 比对 manifest 判断重复。

**重启容错**：Extract 子 chat 走 `parent_chat_id`，`rebuildWaitedChildren` 恢复；Dream 维护 chat 无 parent → 可能残留孤儿 chat（不影响功能，用户可清理）。

## 定时触发器（preset.schedule）

`PresetConfig.schedule` 字段（见 [src/utils/config.ts](../../src/utils/config.ts)）：

```yaml
presets:
  维护:
    leader: curator
    roles: [curator]
    workspace: <path>
    schedule:
      cron: "0 3 * * *"     # 5 字段 cron，本地时区
      task: "Dream：..."     # 交付 leader 执行的任务 prompt
      enabled: true          # [可选] 缺省 true
```

后端 cron scheduler（`src/service/schedule/scheduler.ts`，依赖 `croner`）在 `startService` 期注册：遍历 `config.presets`，对 `schedule.enabled !== false` 的预设 `new Cron(cron, triggerMaintenance)`。到点 `resolvePresetSelection` 取 leader 编制 → `runMaintenanceChat` 创建独立维护 chat 后台跑 task。

**生命周期**：进程重启后 `startScheduleService` 重建；`ServiceHandle.stopSchedule()` 停止所有 cron 任务（测试/关闭用）。

## 依赖与关联

| 方向 | 模块 | 关系 |
|------|------|------|
| 依赖 | `src/utils/config.ts` | 读取 `config.memory.global.{max_count,max_chars}` + `config.memory.workspace.{max_count,max_chars}` + `config.global.memory_dir` |
| 依赖 | `src/db/chat.ts` | `getChatWorkspace(chatId)` 获取 workspace 路径（仅 `scope="workspace"` 时使用） |
| 被依赖 | `src/agent/sense/memory.ts` | memory_manage sense 调用管理器函数（强制带 scope） |
| 被依赖 | `src/agent/prompt/index.ts` | 同时调用 `readMemoryIndexContent(undefined, "global")` 与 `readMemoryIndexContent(workspace, "workspace")` |
| 被依赖 | `src/agent/runtimeResolver.ts` | 硬编码注入 memory_manage 到主 agent senseTable |

## 扩展点

- **新增记忆分类**：修改 `MemoryType` 类型 + `MemoryTypeSchema`（memory.ts sense）
- **新增层（如 per-team）**：在 `MemoryScope` 加值 + `path.ts` 加分支 + config 加对应 `{max_count,max_chars}` + manager `getLimits()` 加分支
- **调整淘汰策略**：修改 `manager.ts` 的 `addMemory()` 中达上限时的处理逻辑
- **自定义存储格式**：修改 `store.ts` 的 `parseMd()` / `serializeMd()`
- **动态更新记忆注入**：需改 middleware 层，每轮重新构建 system prompt
