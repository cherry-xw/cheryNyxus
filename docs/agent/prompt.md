# Agent Prompt（系统提示与技能加载）

> 源码 [src/agent/prompt/](../../src/agent/prompt/) ｜ 上级 [agent](./README.md) ｜ 相关 [./sense.md](./sense.md)（skill 感官）

## 职责

构建 chat 的**首条 system 消息**，以及解析 `.chery/skills/<name>/SKILL.md` 文件的 frontmatter 与正文，供 system prompt 注入技能元数据 + 供 `skill` 感官按需加载完整指令。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [index.ts](../../src/agent/prompt/index.ts) | `buildFirstSystemPrompt()`：拼装 `<system-reminder>` + `<environment>` + `<skills>` 三段 |
| [loadSkill.ts](../../src/agent/prompt/loadSkill.ts) | SKILL.md frontmatter 解析 + 实时遍历 skills 目录（无缓存） |

## 核心概念 / 导出

### buildFirstSystemPrompt（[index.ts](../../src/agent/prompt/index.ts)）

```ts
export default function buildFirstSystemPrompt(): string;
```

输出结构（三段 XML 标签包裹）：

```text
<system-reminder>
{config.global.system_prompt 指向的文件内容}
</system-reminder>

<environment>
操作系统: {os.type()} {os.release()}
当前日期: {YYYY-MM-DD}
当前时间: {ISO}
</environment>

<skills>
<skill name="{name}">
{description}
触发条件: {trigger}      ← P1-5：trigger 作为软提示，供 LLM 判断何时自动触发该 skill
</skill>
...
</skills>
```

**`system_prompt` 路径：** 来自 `config.global.system_prompt`（[utils/config.ts](../../src/utils/config.ts)）。模块加载时一次性读取并 `.trim()`；文件不存在则空串。

**skills 段：** 调用 [getSkillMetas()](../../src/agent/prompt/loadSkill.ts)，每个 skill 仅含 `name`/`description`/`trigger`（**不含 content**）——完整指令按需由 [skill 感官](../../src/agent/sense/skill.ts) 加载，避免 system prompt 膨胀。trigger 缺省则省略「触发条件」行。

> 调用时机：[AgentBuilder.init()](../../src/agent/builder.ts) 在没有历史消息时调 `createInitialMessages()` 构造首条 `{role:"system"}` 消息。

### loadSkill（[loadSkill.ts](../../src/agent/prompt/loadSkill.ts)）

```ts
export interface SkillData {
  name: string;
  description: string;
  content: string;            // frontmatter 之后的正文
  trigger?: string;           // P1-5：自动触发条件描述
}

// 实时读取单个 skill（skill 感官调用，含 size/mtimeMs 供 hash）
export function getSkillRealtime(name: string):
  | { skill: SkillData; size: number; mtimeMs: number }
  | undefined;

// 所有 skill 的元数据（不含 content，system prompt 注入用）
export function getSkillMetas(): Array<{ name: string; description: string; trigger?: string }>;
```

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

## 关键流程

### system prompt 注入流程

```text
AgentBuilder.init(chatId, messages?)
  └─ messages 为空？→ createInitialMessages()
       └─ buildFirstSystemPrompt()
            ├─ readFileSync(config.global.system_prompt)  （模块加载期一次性）
            ├─ getSkillMetas()  ← readAllSkills() 实时遍历
            └─ 拼装三段返回
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
| [utils/config](../../src/utils/config.ts) | `config.global.system_prompt`（system prompt 文件路径）、`config.global.skills_dir`（skills 目录） |
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
- 配置项 `skills_dir` / `system_prompt` 见项目 README 的 config.yaml 章节

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

system prompt 主体内容由 `config.global.system_prompt` 指向的文件决定（运行时读取，不缓存）。**结构**（XML 标签包裹顺序）由 [index.ts](../../src/agent/prompt/index.ts) 硬编码——若要改三段顺序、增删段，改 [index.ts](../../src/agent/prompt/index.ts) 的模板字符串。

> 注意：`buildFirstSystemPrompt` 仅在 chat 创建时调一次；改 system prompt 文件后**存量 chat 不受影响**（首条 system 消息已固化在内存与 DB）。
