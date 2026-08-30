# 角色端到端验收

> 运行资产：`.chery/skills/role-acceptance/SKILL.md`、`.chery/prompt/roleAcceptance/roleAcceptance.md`
> 配置入口：`sense_groups.chery_nexus`、`roles.roleAcceptance`、`presets.cheryNyxus.roles`
> 后端设计：[../../docs/agent/role-acceptance.md](../../docs/agent/role-acceptance.md)

Cherry Nexus 在目标配置成为当前激活修订后，激活 `role-acceptance` 技能并调用 `role_acceptance` 感官。验收器为每个场景创建新的系统临时目录和进程内临时 Agent，用目标角色真实大脑、提示词和安全工具执行，再由隐藏的 `roleAcceptance` 角色独立判定。

## 强制边界

- 工具为目标角色原有工具与安全白名单的交集。
- 文件、搜索、写入和命令工作目录只能位于临时工作区。
- 命令最高为 `workspace-write`；破坏性、提权、系统、网络、凭证、动态代码、混淆和未知命令拒绝。
- 不开放配置修改、技能安装、角色派发/控制、用户提问、记忆、媒体和 MCP。
- 角色自身显式 `deny` 始终保留；安全的本地 `ask` 操作由无人值守验收器预批准。
- 每个场景结束后清理临时目录，不写入正常会话和节点树。

## 报告

报告包含活动配置修订、逐场景状态、工具轨迹、产物、缺失产物、覆盖缺口和人工复核项。期望产物缺失等确定性失败不能被模型评估的 `pass` 覆盖。联网、MCP、外部发送和生产访问不会被隔离验收测试，必须保留为覆盖缺口。
