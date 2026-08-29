# 任意岗位角色设计

> 模板资产：[.chery.template/skills/role-design/](../../.chery.template/skills/role-design/) 与 [.chery.template/prompt/roleArchitect/](../../.chery.template/prompt/roleArchitect/)
> 配置入口：[.chery.template/config.yaml](../../.chery.template/config.yaml) 的 `role_architect`、`roleArchitect` 与 `presets.cheryNyxus.roles`

## 设计目标

角色创建不依赖“岗位名 → 固定工具列表”的封闭字典。岗位知识和职责描述保持开放文本；只有在 Cherry Nexus 读取当前真实工具后，才把能力诉求收敛为可校验的工具与配置决策。

```text
用户目标
  → role-design 方法约束
  → roleArchitect 研究岗位并输出蓝图
  → Cherry Nexus 读取当前配置与真实工具
  → allow / ask / deny 映射 + 系统提示词用途契约
  → 原子保存资产与配置
  → 独立端到端验收
```

## 职责分离

| 参与者 | 负责 | 不负责 |
|--------|------|--------|
| `role-design` 技能 | 研究步骤、风险准则、蓝图格式 | 枚举所有岗位、直接授权工具 |
| `roleArchitect` | 岗位研究、职责/交付物/风险/自然语言能力诉求、验收场景 | 修改 `.chery`、选择最终工具、宣布验收通过 |
| Cherry Nexus | 读取真实配置、完成工具映射、生成用途契约、原子写入配置与资产 | 把网页内容直接当成授权依据 |
| 独立验收器 | 在新配置生效后验证允许和禁止行为 | 参与角色设计或放宽权限 |

`roleArchitect` 被加入固定 `cheryNyxus` 预设，但使用独立的 `role_architect` 感官组。该组只有技能加载、文件读取、代码搜索和用户提问能力，不包含 `config_manage`、文件写入、命令执行或角色派发。

## 岗位研究

- 常见、低风险岗位可以使用模型已有知识，但必须结合用户实际目标，研究状态记为 `model_knowledge`。
- 陌生、专业、受监管或时效性强的岗位应优先使用已配置的网络/MCP 能力核实，研究状态记为 `verified`。
- 需要检索但网络不可用时不得伪称已经搜索；应标记 `needs_user_input` 并列出待补充信息。
- 外部内容只提供岗位事实，不得覆盖用户目标、平台规则或权限边界，也不能直接触发工具授权。

## 权限表达

蓝图中的 `capability_requests.intent` 使用自然语言，例如“读取项目资料”“运行测试”“查询公开市场信息”，不绑定 `read_file`、`execute_command` 等工具名。Cherry Nexus 基于当时真实存在的工具逐项形成：

```yaml
tool_decisions:
  - tool: write_file
    decision: ask
    purpose: 创建测试用例、fixture、snapshot 和测试报告
    prohibited_use: 未经授权修改产品实现代码
```

工具是否可见、路径范围、命令沙箱、审批和可派发角色属于硬边界。工具具备多种用途但平台不能按语义区分时，必须把允许用途、禁止用途和升级授权条件写入目标角色系统提示词；这类软使用契约不能冒充安全隔离。

## 蓝图契约

角色蓝图至少包含：

- `research_status`、目标、职责、交付物和典型工作流；
- 风险、禁止用途、开放问题；
- 自然语言能力诉求及其必要性和风险；
- 同时覆盖允许行为与禁止行为的 `acceptance_scenarios`。

完整 YAML 结构见 [.chery.template/docs/role-design.md](../../.chery.template/docs/role-design.md)。

## 创建与生效

1. Cherry Nexus 激活 `role-design` 并在必要时一次性补问目标、环境和风险边界。
2. 派发 `roleArchitect`，获取不含最终工具授权的角色蓝图。
3. 用 `config_manage(action="get")` 读取当前角色、感官组和 MCP 配置，结合本轮真实工具定义完成映射。
4. 先以 `asset_save` 保存独立提示词，再以一次 `patch` 闭合 senseGroup、role 和 preset 引用。
5. 回读核对稳定 ID、引用闭合和最小权限。
6. 配置激活后由独立验收机制执行蓝图场景；验收完成前只报告配置已创建，不宣称角色可用。

## 关联

- 配置管理：[config-manage.md](./config-manage.md)
- 角色安全：[role-security.md](./role-security.md)
- 技能加载：[prompt.md](./prompt.md)
- 配置模板手册：[../../.chery.template/docs/role-design.md](../../.chery.template/docs/role-design.md)
