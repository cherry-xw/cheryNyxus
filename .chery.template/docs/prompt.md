# prompt — System Prompt 与角色提示词

> 模板目录：`.chery.template/prompt/` ｜ 运行位置：`.chery/prompt/`
> 加载入口：[src/agent/prompt/](../../src/agent/prompt/) ｜ 详细文档：[../../docs/system-prompt.md](../../docs/system-prompt.md)

## 用途

存放 system prompt 与各角色的专属提示词。`.chery/config.yaml` 中 `roles.<role>.systemPrompt` 字段引用此处路径（相对 `.chery/`）。

## 目录结构

```
prompt/
  system.md                      # 全局 system prompt（每次对话注入）
  prefebMain/                    # 预设角色提示词（leader / plan / coder / reviewer）
    leader.md
    planner.md
    coder.md
    reviewer.md
  cheryNyxus/                    # Cherry Nexus 专属提示词（配置管理核心角色）
    cheryNyxus.md
  roleArchitect/                 # 任意岗位研究与角色蓝图；不写配置
    roleArchitect.md
  roleAcceptance/                # 独立角色验收证据评估；运行时无工具
    roleAcceptance.md
```

## 文件类型

| 文件 | 作用 | 引用方式 |
|------|------|----------|
| `system.md` | 全局对话规则（用户意图分析 / 工具使用规范 / 指令标记识别） | 框架启动期注入每个 chat |
| `prefebMain/leader.md` | 主角色（coordinator）的专属指令 | `roles.coordinator.systemPrompt` |
| `prefebMain/planner.md` | 计划角色（plan）的专属指令 | `roles.plan.systemPrompt` |
| `prefebMain/coder.md` | 编码角色（coder）的专属指令 | `roles.coder.systemPrompt` |
| `prefebMain/reviewer.md` | 审查角色（reviewer）的专属指令 | `roles.reviewer.systemPrompt` |
| `cheryNyxus/cheryNyxus.md` | Cherry Nexus（配置管理核心角色：管理角色/感官/全局/llm 配置 + 组长） | `roles.cheryNyxus.systemPrompt` |
| `roleArchitect/roleArchitect.md` | Role Architect（研究岗位、输出职责/风险/能力诉求/验收蓝图，不修改配置） | `roles.roleArchitect.systemPrompt` |
| `roleAcceptance/roleAcceptance.md` | 独立验收器（只依据隔离证据返回结构化 verdict，不执行目标任务） | `roles.roleAcceptance.systemPrompt` |

## 字段参考表

### 引用字段（config.yaml）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `roles.<role>.systemPrompt` | string | ✅ | 路径相对 `.chery/`，如 `prompt/prefebMain/leader.md`；启动校验文件必须存在 |

### system.md 结构（参考模板）

| 段 | 作用 |
|----|------|
| `# 角色与目标` | 顶层职责定义 |
| `# 用户表述分析` | 言语行为分类（断言 / 指令 / 承诺 / 表达 / 宣告）+ 处理策略 |
| `# 工具(Tool)使用` | 强调仅通过 tool use 与外部交互，单回合单动作 |
| `# 技能（Skill）使用` | `<skills>` 段加载指引 |
| `# 用户消息中的指令标记` | `[[command:/名称]]` 识别与处理 |

### 角色提示词结构（参考模板）

| 段 | 作用 |
|----|------|
| `## 职责` | 该角色的核心任务与边界 |
| `## 工作流程` | 典型场景的执行步骤 |
| `## 边界 / 约束` | 不该做的事、安全规则 |
| `## 协作接口` | 与其他角色的交互（如 spawn_role / 转述结果） |
| `## 注意事项` | 失败处理、回报规范 |

## 模板示例（cherryNyxus）

```md
你是 Cherry Nexus：系统的配置管理核心角色，也是桌宠组长。
你的核心任务是管理所有角色配置相关的任务（对设置相关信息进行维护调整）。

## 职责

收到配置调整请求时：
1. 用 config_manage(action="get") 读取当前完整脱敏配置并记录 baseRevision
2. 对照 .chery.template/docs/ 字段参考表，定位目标字段
3. 用 ask_user_question 向用户确认变更（含改动前后对比、影响范围）
4. 用 config_manage(action="patch") 携带 baseRevision 与强类型资源级 operations；服务端校验候选后落盘并自动备份
5. 若类型、revision 或候选校验失败：不落盘，回报错误原文；revision 过期重新 get
6. 提示用户重启生效（配置不热更）
...
```

详见 [../prompt/cheryNyxus/cheryNyxus.md](../prompt/cheryNyxus/cheryNyxus.md)。

## 编写建议

- **职责清晰**：开头一段说清「我是谁 / 做什么 / 不做什么」
- **流程可执行**：用编号列表给出典型场景的步骤，不要「根据情况灵活处理」式废话
- **边界明确**：列出禁止动作（如「不要直接写 `.chery/`，用 install_skill」）
- **失败显性**：明确「失败时如何回报」，绝不静默吞错
- **依赖声明**：列出该角色使用的感官 / 子角色，避免 LLM 误用

## 注意事项

- 修改后**重启生效**（system prompt 在 chat 启动期注入）
- 文件不存在 → 启动校验失败（`validateRawConfig`）
- 路径必须相对 `.chery/`，绝对路径或 `../` 上溯会被校验拦截
- 角色提示词中引用的感官 / 子角色必须存在于该角色的 `senseGroup` / `roles`，否则 LLM 调用会失败

## 关联

- 角色配置：[./config.md#rolesrole-字段](./config.md#rolesrole-字段)
- 提示词系统：[../../docs/system-prompt.md](../../docs/system-prompt.md)
- Cherry Nexus 提示词：[../prompt/cheryNyxus/cheryNyxus.md](../prompt/cheryNyxus/cheryNyxus.md)（配置管理 + 组长）
- Role Architect 提示词：[../prompt/roleArchitect/roleArchitect.md](../prompt/roleArchitect/roleArchitect.md)（岗位研究 + 蓝图，不授权工具）
- Role Acceptance 提示词：[../prompt/roleAcceptance/roleAcceptance.md](../prompt/roleAcceptance/roleAcceptance.md)（隔离证据独立评估，无工具）
- 任意岗位角色设计：[./role-design.md](./role-design.md)
- 角色端到端验收：[./role-acceptance.md](./role-acceptance.md)
- 配置管理感官：[../../docs/core/sense.md](../../docs/core/sense.md#config_manage-感官)（get/patch/backup/rollback）
