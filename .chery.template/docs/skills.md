# skills — 技能包

> 模板目录：`.chery.template/skills/` ｜ 运行位置：`.chery/skills/`
> 加载入口：[src/agent/prompt/loadSkill](../../src/agent/prompt/loadSkill.ts) ｜ 详细文档：[../../docs/agent/prompt.md](../../docs/agent/prompt.md)

## 用途

技能（Skill）是**可加载的提示词片段**，补充 LLM 的领域知识与操作指引。LLM 在 `<skills>` 段看到可用技能名 + 描述，按需调用 `skill` 感官加载完整指令。

每个技能是一个目录，含 `SKILL.md`（frontmatter + 正文）。

## 目录结构

```
skills/
  <skill-name>/
    SKILL.md                # 必填：技能定义
    ...                     # 可选：附加资源（脚本、模板、数据）
```

**技能名 = 目录名**（在 `skill` 感官调用时传入）。

## SKILL.md 字段

### YAML Frontmatter（顶部三划线包裹）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | 技能名（与目录名一致；供加载校验） |
| `description` | string | ✅ | 一句话功能描述（出现在 `<skills>` 列表，LLM 据此判断是否加载） |
| `trigger` | string | ❌ | 触发场景描述（仅文档作用，供人工/Agent 决策参考） |

### 正文（Markdown）

技能完整指令。可包含：
- 标题层级（`#` `##` `###`）
- 代码块、列表、表格
- 调用其他感官 / 派生子 agent 的指引
- 注意事项、安全约束

## 内置感官 `skill`

```ts
skill(name: string) → string    // 加载技能正文，注入当前对话上下文
```

- 实时扫描 `.chery/skills/`（无需重启）
- 加载失败（无 `SKILL.md` / frontmatter 校验失败）返回错误，**不静默吞掉**
- 加载成功 → 正文作为 system context 片段注入

## 模板示例（haveFun）

[../skills/haveFun/SKILL.md](../skills/haveFun/SKILL.md)：赛博朋克笑话生成器，演示复杂 Markdown（含代码块 / ASCII art / 表情符号）的写法。

## 模板示例（install-skill）

[../skills/install-skill/SKILL.md](../skills/install-skill/SKILL.md)：识别用户「安装技能」意图后，调用 `spawn_role` 派出 `cheryNyxus` 角色执行安装。演示技能如何协调其他感官与角色。

## 字段参考表

| 元素 | 类型 | 必填 | 说明 |
|------|------|------|------|
| 目录名 | string | ✅ | 技能标识；在 `skill` 感官调用时使用 |
| `SKILL.md` | file | ✅ | 技能定义文件 |
| frontmatter `name` | string | ✅ | 校验必须与目录名一致 |
| frontmatter `description` | string | ✅ | 一句话功能描述（影响 LLM 加载决策） |
| frontmatter `trigger` | string | ❌ | 触发场景说明（文档性质） |
| 正文 | markdown | ✅ | 完整指令；支持标准 Markdown 语法 |

## 编写建议

- **description 简洁**：LLM 只看这一行决定是否加载；避免「这是一个会...的技能」废话
- **正文结构化**：用 `## [步骤]` / `## [注意]` 分块，便于 LLM 解析
- **可执行指令**：明确「调用 XX 感官」「spawn XX 角色」等具体动作
- **安全约束**：写明禁止动作（如「不要直接写 `.chery/`，路径守卫会拦」）
- **失败处理**：明确「失败时如何回报」，避免 LLM 静默吞错

## 注意事项

- 技能修改后**无需重启**：loadSkill 实时扫描 `.chery/skills/`，下一轮对话自动出现
- `name` 与目录名不一致 → 加载失败
- frontmatter 缺失 `name` / `description` → 加载失败
- 加载成功的技能在对话上下文累积；过多技能会撑爆 contextLimit

## 关联

- 技能加载：[src/agent/prompt/loadSkill](../../src/agent/prompt/loadSkill.ts)
- 安装技能：由 `cheryNyxus` 角色的 `install_skill` 感官负责（详见 [./prompt.md](./prompt.md#cherrynexus-提示词)）
- 模板示例：[../skills/haveFun/SKILL.md](../skills/haveFun/SKILL.md)、[../skills/install-skill/SKILL.md](../skills/install-skill/SKILL.md)