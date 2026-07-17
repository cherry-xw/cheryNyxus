# Agent Prompt（系统提示与技能加载）

> 源码 [src/agent/prompt/](../../src/agent/prompt/) ｜ 上级 [agent](./README.md) ｜ 相关 [./sense.md](./sense.md)（skill 感官）

## 职责

构建 chat 的**首条 system 消息**，以及解析 `.chery/skills/<name>/SKILL.md` 文件的 frontmatter 与正文，供 system prompt 注入技能元数据 + 供 `skill` 感官按需加载完整指令。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [index.ts](../../src/agent/prompt/index.ts) | `buildFirstSystemPrompt()`（拼装 `<system-reminder>`+`<environment>`+`<workspace>`+`<skills>`，**全局 base + override 合并**）+ `buildSystemPromptSegments()`（分段计量） |
| [loadSkill.ts](../../src/agent/prompt/loadSkill.ts) | SKILL.md frontmatter 解析 + 实时遍历 skills 目录（无缓存） |
| [listPrompts.ts](../../src/agent/prompt/listPrompts.ts) | `listPrompts()`：递归遍历 `.chery/prompt/`，返相对路径列表（供 `prompts.list` RPC + 前端级联选择器）；**排除全局 base `system.md`** |

## 核心概念 / 导出

### buildFirstSystemPrompt（[index.ts](../../src/agent/prompt/index.ts)）

```ts
export default function buildFirstSystemPrompt(promptPathOverride?: string, workspace?: string): string;
```

- 全局 base：模块加载期读取固定路径 `config.global.prompts_dir + "/system.md"`（即 `CHERY_DIR/.chery/prompt/system.md`，统一目录源；不再走 `config.global.system_prompt` 配置字段）。
- `promptPathOverride` 给出（per-subagent / 预设 main）→ 实时 `readFileSync` 该路径作为**补充**拼接到全局 base 之后（**合并**而非替换；**不**走模块缓存，支持每子 agent 不同 prompt 文件）；文件缺失则 warn 并仅用全局 base（运行期容错，配置期 `validateRawConfig` 已 existsSync 校验）。
- `workspace` 给出（预设 `presets.<name>.workspace`）→ 在 `<environment>` 后注入 `<workspace>` 段（提示词层面声明本会话的项目工作目录，**不**改变 sense 实际行为）；缺省 → 不注入该段。

输出结构（XML 标签包裹；`<workspace>` 仅 `workspace` 给出时出现）：

```text
<system-reminder>
{全局 base（.chery/prompt/system.md）+ override 补充（promptPathOverride 给出时，合并拼接于 base 之后）}
</system-reminder>

<environment>
操作系统: {os.type()} {os.release()}
当前日期: {YYYY-MM-DD}
当前时间: {ISO}
</environment>

<workspace>              ← 仅 workspace 给出时注入
当前工作区: {workspace}
本会话用于开发该项目，文件操作与命令以此目录为基准。
</workspace>

<skills>
<skill name="{name}">
{description}
触发条件: {trigger}      ← P1-5：trigger 作为软提示，供 LLM 判断何时自动触发该 skill
</skill>
...
</skills>
```

**全局 system prompt 路径：** 固定为 `config.global.prompts_dir + "/system.md"`（即 `CHERY_DIR/.chery/prompt/system.md`，单一目录源；不再经 `config.global.system_prompt` 配置字段，见 [utils/config.ts](../../src/utils/config.ts)）。模块加载时一次性读取并 `.trim()`；文件不存在则空串。

**skills 段：** 调用 [getSkillMetas()](../../src/agent/prompt/loadSkill.ts)，每个 skill 仅含 `name`/`description`/`trigger`（**不含 content**）——完整指令按需由 [skill 感官](../../src/agent/sense/skill.ts) 加载，避免 system prompt 膨胀。trigger 缺省则省略「触发条件」行。

> 调用时机：[AgentBuilder.init()](../../src/agent/builder.ts) `init(chatId, messages?, promptPathOverride?)`——构造首条 `{role:"system"}` 消息。

### 重启 persona 修复 + per-subagent system prompt

**persona 丢失 bug（已修复）**：`observer` 不持久化 system 消息（[service/chat/observer.md](../service/chat.md)），重启后 `loadHistory` 返回的 messages 不含 system → 原 `init`「有历史就不加 system」逻辑致主/子 agent 丢 persona。修复：`init` 统一保证内存 messages 首条为 system——历史存在但首条非 system（重启场景）则 `prepend createInitialMessages(promptPathOverride)`，首条已是 system 则原样用，无历史则 `[systemMsg]`。

**per-agent system prompt（T7，主/子通用，T6 扩展至预设）**：主/子 agent 均可配专属 system prompt，数据流：
```text
来源：config.roles[type].systemPrompt（角色）或 config.presets[preset].leader.systemPrompt（预设主 agent）
  （文件路径，相对 .chery；作为补充合并到全局 base 之后）
  → 写入 chat metadata.promptPathOverride
    （spawn createChat 写子 agent / chat.create 写预设主 agent）
  → ensureChat 读 getChatPromptOverride(chatId)
  → builder.init(chatId, history, promptPathOverride)
  → buildFirstSystemPrompt(promptPathOverride) 合并「全局 base + override 补充」→ 首条 system
```
无 `promptPathOverride`（metadata 无此字段：非预设主 agent / 旧 chat）→ 仅全局 base（`.chery/prompt/system.md`）。字段名从 `subagentPromptPath` 改为 `promptPathOverride`（T6：主 agent 经预设亦用此机制，名需主/子通用）。

**per-preset workspace（项目工作目录，提示词层注入）**：预设可配 `workspace` 字段声明该预设创建的会话专属某个项目，数据流：
```text
来源：config.presets[preset].workspace（项目根绝对路径；缺省 → 不注入）
  → 写入 chat metadata.workspace
    （chat.create 写预设主 agent / spawn createChat 继承主 chat workspace 写子 agent）
  → ensureChat 读 getChatWorkspace(chatId)
  → builder.init(chatId, history, promptPathOverride, workspace)
  → buildFirstSystemPrompt(promptPathOverride, workspace) → 注入 <workspace> 段
```
**仅提示词层声明**：workspace 只在 system prompt 注入一段说明，**不**改变 bash/read_file/write_file 等感官的实际行为（无 cwd 收束、无路径沙箱）。无 `workspace`（非预设 chat / 预设未配 / 旧 chat）→ 不注入该段，行为同系统全局。

### prompts 目录与列举（[listPrompts.ts](../../src/agent/prompt/listPrompts.ts)）

**`.chery/prompt/`** 是唯一 prompt 目录——含全局 base `system.md`（模块加载期缓存，详见 [index.ts](../../src/agent/prompt/index.ts)）+ per-agent override 子文件夹（如 `prompt/prefebMain/{leader,planner,coder,reviewer}.md`）。**支持任意层级子文件夹**——一个子文件夹即「一组」相关角色 prompt。`systemPrompt` 配置值相对 `.chery/`，可含子目录（如 `prompt/prefebMain/leader.md`），路径解析与 `existsSync` 校验对子目录透明。

```ts
// 递归遍历 config.global.prompts_dir，仅收 .md（排除 system.md），返相对 .chery/ 路径（含 prompt/ 前缀）
export function listPrompts(): string[];
```

目录不存在或空 → 返 `[]`（合法状态，不 fail loud）。实时遍历不缓存（类比 `readAllSkills`），新增/改动/新建子文件夹下次调用即反映。

> **RPC `prompts.list`**：[service/prompt/list.ts](../../src/service/prompt/list.ts) 的 `handlePromptsList` 包一层返 `{ prompts: listPrompts() }`，供前端设置面板 `systemPrompt` **级联选择器**（`el-cascader`）构建目录树——叶节点 `value` = 全路径（= 存储值），顶层 `prompts` 段剥掉，级联从组文件夹开始。详见 [protocol.md](../protocol.md) 方法表。

### loadSkill（[loadSkill.ts](../../src/agent/prompt/loadSkill.ts)）

```ts
export interface SkillData {
  name: string;
  description: string;
  content: string;            // frontmatter 之后的正文
  trigger?: string;           // P1-5：自动触发条件描述
  extra?: Record<string, unknown>;  // frontmatter 其余用户自定义字段（保留全部）
}

// 一次性计算 skill 所有 token 字段（单一来源，调用方直接复用，不重算）
//   - nameDescTokens: name + description
//   - triggerTokens: trigger 行（无则 0）
//   - contentTokens: 正文 content
//   - promptTokens: JSON 序列化全字段（含 extra），用作正文段 token 计算
//   - contextTokens: promptTokens 别名，前端展示「激活该 skill 后预计新增 token」用
// **仅计算 SKILL.md 的部分 token 消耗，不包含其他附加拆分的技能内容**——
//   不含激活包装前缀、不含 <skill> XML 标签外壳。
export interface SkillTokenBreakdown {
  nameDescTokens: number;
  triggerTokens: number;
  contentTokens: number;
  promptTokens: number;
  contextTokens: number;
}
export function computeSkillTokens(s: SkillData): SkillTokenBreakdown;

// 实时读取单个 skill（skill 感官调用，含 size/mtimeMs 供 hash）
export function getSkillRealtime(name: string):
  | { skill: SkillData; size: number; mtimeMs: number }
  | undefined;

// 所有 skill 的元数据（含预计算 token，system prompt 注入 / 发送窗口 / 分段计量复用）
export function getSkillMetas(): Array<SkillData & SkillTokenBreakdown>;
```

### 前端指令列表与强制加载

`skills.list` RPC 复用 `getSkillMetas()`，实时返回用户配置目录中的
`{ name, description, trigger?, extra?, nameDescTokens, triggerTokens, contentTokens, promptTokens, contextTokens }`。

- **`contextTokens`**：激活该 skill 后预计新增的上下文 token（即 `promptTokens`，JSON 序列化全字段）——前端发送窗口 `/` 命令菜单 hover 卡片展示「Token 消耗量」。
- **`nameDescTokens` / `triggerTokens` / `contentTokens` / `promptTokens`**：分别对应 SKILL.md 各部分 token，由 `computeSkillTokens` 一次性算好供后端 `computeContextBreakdown` 与正文段直接复用，不重复 estimateTokens。
- **`promptTokens`**：JSON 序列化全字段（含 extra 用户自定义字段）的 token——按设计用作正文段的 token 计算（与 skill 感官调用结果注入上下文的体量一致）。

前端在发送窗口输入 `/`
时据此展示可选命令；选中某个 `/<name>` 后，会在富文本编辑器的用户正文中插入一个带专用底色的
不可编辑 tag。tag 仅显示不带 `/` 的指令词（例如选择 `/compact` 后显示 `compact`）；hover 的
popover 卡片分为标题、可换行描述和底部 token 元信息。token 总量包含本条消息的指令标记本身，
技能还会叠加 `contextTokens`；因此内置 compact 也能显示非零的标记消耗。用户可用编辑器的
Backspace 或 Delete 一次移除整个 tag。传输和持久化时 token 序列化为
`[[command:/<name>]]`，不会发送 HTML，也不会把完整 Skill 正文传到前端。

指令 token 的语义由全局 system prompt 统一约定，而非由发送端为每条消息拼接具体提示词：

- `[[command:/<skill-name>]]`：模型先调用 `skill` 感官加载同名技能，再处理同一条消息其余正文；
- `[[command:/compact]]`：模型压缩当前会话的关键事实、决策、进度和待办；
- 多个 token 按它们在用户正文中的顺序处理。

历史消息仍保存纯文本。前端会安全识别上述固定格式并将其渲染为指令样式，其他用户文本继续按
纯文本转义显示。

`/compact` 是固定入口的系统命令：它序列化为 `[[command:/compact]]`，但完整指令位于
`.chery/command/compact.md`（模板为 `.chery.template/command/compact.md`），可直接编辑并在下次
构建系统提示词时读取。它不属于 `SKILL.md`，不会由 `getSkillMetas()` 或 `skills.list` 返回，也不进入
用户技能的删除范围。

当 compact 的 assistant 摘要完成后，消息本身会持久化 `context_compaction` 边界。当前运行立即将模型
上下文收缩为“基础系统提示词 + 系统角色摘要”；服务重启后同样从最后一条边界恢复。边界同时持久化按
`estimateTokens` 估算的释放量，历史分割线显示“释放约 N tokens”。旧消息只供历史 UI 回放，不再送入模型。

**SKILL.md frontmatter 格式：**

```markdown
---
name: my-skill                # 可选，缺省用目录名
description: My custom skill  # 必填（缺省空串）
trigger: "用户请求XXX时触发"   # 可选
---

正文内容（content）...
```

frontmatter 用 [js-yaml](https://github.com/nodeca/js-yaml) 解析，正则 `/^---\r?\n([\s\S]*?)\r?\n---/` 匹配首块。解析失败时**静默回退**：name 用目录名、description/content 各自为整文件 trim / 空。

## 命令（基于 `[[command:/name]]` 的指令系统）

`commands` 不再预注入 system prompt。`/compact` 等内置命令位于 `.chery/command/<name>.md`，
**不在默认 system 提示词中**——只在被触发时（用户 `[[command:/compact]]` / 自动压缩命中），
由 send 路径实时读取并以 `<system-reminder type="compact-instruction">…</system-reminder>`
作为**一次性**附注拼到该轮 user prompt 末尾（不入系统提示词缓存）。

完整协议、阈值与「指令」tab 详见 [./command.md](./command.md)。

前端「指令」tab（settings 第八项）按需增删改 `.chery/command/*.md`——后端只暴露
`command.list / read / save / delete` 四个 RPC；不属于 `SKILL.md` 体系，
不会进 `getSkillMetas()` 与用户技能的删除范围。

## 上下文分段计量（buildSystemPromptSegments）

```ts
export interface PromptSegmentText { text: string; count?: number }
export interface SkillsSegmentTokens {
  nameDescTokens: number;
  triggerTokens: number;
  contentTokens: number;
  promptTokens: number;
}
export function buildSystemPromptSegments(promptPathOverride?: string, workspace?: string): {
  system: string;      // 全局 base + <environment> + <workspace>
  userSystem: string;  // override 补充（promptPathOverride 给出时；合并语义，可与 system 并存）
  memory: PromptSegmentText;   // <memory global>+<workspace>，count = 记忆条数
  skills: PromptSegmentText & SkillsSegmentTokens;   // <skills> 元数据 + 预聚合 token（computeSkillTokens 累加）
};
```

完整 **6 段上下文计量**（[utils/token.ts](../../src/utils/token.ts) `computeContextBreakdown`）：

| 段 | 来源 | token 计算 | count |
|----|------|------------|-------|
| 系统提示词 | 全局 base + `<environment>` + `<workspace>` | estimateTokens(text) | — |
| 用户系统提示词 | override 补充（合并语义，可与系统提示词并存） | estimateTokens(text) | — |
| 记忆 | `<memory global>` + `<memory workspace>` | estimateTokens(text) | 记忆条数 |
| 技能 | `<skills>` 元数据 | `Σ triggerTokens`（loadSkill 预计算，单一来源） | skill 数 |
| 工具定义 | runtime senseTable 各 sense `definition` schema | Σ estimateTokens(JSON.stringify(sense)) | tool 数 |
| 用户对话 | DB 消息行 role∈user/assistant/role/subagent/**sense**（含感官调用结果） | Σ estimateTokens(content+thinking) | 消息条数 |

**skills 段 token 来源（单一来源原则）：** `computeSkillTokens` 在 [loadSkill.ts](../../src/agent/prompt/loadSkill.ts) 一次性算好 `nameDescTokens`/`triggerTokens`/`contentTokens`/`promptTokens`/`contextTokens`，`buildPromptPieces` 累加成 `skillsTokens`，`buildSystemPromptSegments.skills` 直接返回，`computeContextBreakdown.skills` 复用 `triggerTokens`——**不在 contextUsage 重新 estimateTokens**，避免重复计算和口径不一致。

**计量时机（recompute-at-compute）：** `computeContextBreakdown(chatId)` 从 chat metadata 取 `promptPathOverride`+`workspace`、从 `getChatRuntimeSelection` 取 runtime，重建各段文本与 senseTable。skills 段 token 直接复用预计算字段；其他段按需 estimateTokens。**不持久化 breakdown**——系统消息不入库，memory 按设计仅 init 一次性注入、recompute 偏差可忽略。详见 [utils/token.ts](../../src/utils/token.ts)。

## 关键流程

### system prompt 注入流程

```text
AgentBuilder.init(chatId, messages?, promptPathOverride?, workspace?)
  ├─ 构造 systemMsg = createInitialMessages(promptPathOverride, workspace)[0]
  ├─ messages 空？→ [systemMsg]
  ├─ messages 非空且首条 role!==system（重启后 observer 不持久化 system）→ [systemMsg, ...messages]（persona 修复）
  └─ messages 首条已是 system → messages 原样
       └─ createInitialMessages → buildFirstSystemPrompt(promptPathOverride, workspace)
            ├─ 全局 base = 模块加载期缓存的 .chery/prompt/system.md
            ├─ promptPathOverride 给出 → readFileSync(override)（实时，非缓存）作补充拼接到 base 之后
            ├─ workspace 给出 → 注入 <workspace> 段（否则省略）
            ├─ getSkillMetas()  ← readAllSkills() 实时遍历
            └─ 拼装四段返回
```

### skill 完整指令加载流程（运行时）

```text
LLM 决定触发某 skill（基于 system prompt 中的 trigger 软提示）
  → 调 skill 感官 {name}
       → getSkillRealtime(name)
            └─ readAllSkills() 遍历，找到 name 匹配的 SKILL.md
                 ├─ parseSkillFrontmatter 解析
                 └─ statSync 取 size/mtimeMs
       → hash = hashGenerator("skill", name, size, mtimeMs)
       → content = `"${name}"技能已激活。以下是完整指令...${skill.content}`
       → 返回给 LLM 作为感官结果
```

**为什么实时遍历不缓存：** P1-4 重构（[loadSkill.ts readAllSkills 注释](../../src/agent/prompt/loadSkill.ts)）。原模块级 `skillMap` 缓存导致新增/改动 SKILL.md 不反映；改为实时遍历保证配置热更可见（类比 sense 的 `reloadSenses`）。

### skills 目录查找规则

```ts
const skillsDir = config.global.skills_dir;
// 遍历 skillsDir 下每个子目录
//   → 找名为 "skill.md"（大小写不敏感）的文件
//   → 解析 frontmatter
//   → name 冲突时 logger.warn，后者覆盖前者
```

文件名匹配用 `f.toLowerCase() === "skill.md"`，所以 `SKILL.md` / `Skill.md` / `skill.md` 均可。

## 依赖与关联 ⭐

### 依赖

| 依赖 | 用途 |
|------|------|
| [utils/config](../../src/utils/config.ts) | `config.global.skills_dir`（skills 目录）、`config.global.prompts_dir`（唯一 prompt 目录：含全局 base `system.md` + per-agent override 子文件夹） |
| 第三方 `js-yaml` | frontmatter YAML 解析 |
| 第三方 `dayjs` | 当前日期/时间格式化 |
| Node `fs`/`os` | 文件读取、操作系统信息 |

### 被依赖

| 调用方 | 用途 |
|--------|------|
| [agent/builder.ts](../../src/agent/builder.ts) | `buildFirstSystemPrompt()`（首条 system 消息） |
| [agent/sense/skill.ts](../../src/agent/sense/skill.ts) | `getSkillRealtime(name)`（skill 感官加载完整指令） |

### 横切参考

- [./sense.md](./sense.md) — `skill` 感官如何消费 `getSkillRealtime` 返回的 size/mtimeMs 生成 hash
- 配置项 `skills_dir` 见项目 README 的 config.yaml 章节；全局 system prompt 固定 `.chery/prompt/system.md`（不再配置）

## 扩展点

### 添加 Skill

1. 在 `.chery/skills/<name>/` 创建目录（目录名作为缺省 skill name）。
2. 创建 `SKILL.md`（文件名大小写不敏感）：

   ```markdown
   ---
   name: my-skill
   description: 一句话描述（会注入 system prompt 的 <skills> 段）
   trigger: "用户请求XXX时触发"   # 可选，软提示
   ---

   ## 技能说明
   完整指令正文。LLM 调用 skill 感官后会收到这段内容。
   ```

3. 无需重启或注册——`readAllSkills` 实时遍历，下次新 chat 即可见。
4. LLM 据 system prompt 中的 `<skill>` 块判断何时自动调用 `skill` 感官加载完整指令。

### 修改 system prompt 模板

system prompt 主体内容由固定路径 `.chery/prompt/system.md` 决定（模块加载期读取并缓存）。**结构**（XML 标签包裹顺序）由 [index.ts](../../src/agent/prompt/index.ts) 硬编码——若要改三段顺序、增删段，改 [index.ts](../../src/agent/prompt/index.ts) 的模板字符串。

> 注意：`buildFirstSystemPrompt` 在 chat 创建（`ensureChat`→`init`）时调一次；改 system prompt 文件后**存量 chat 内存首条 system 已固化**。但服务**重启**后 `init` 会因「历史无 system」重新 prepend（persona 修复），故重启后存量 chat 反映新 prompt；运行期改文件需重启生效。
