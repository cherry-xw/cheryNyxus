# 万象台

**状态：** 规划中  
**进度：** 0/28 个任务，0/112 个执行步骤  
**当前可执行：** C01、S01

## 目标与边界

让多个预设实例作为团队，为同一任务进行讨论、决策、独立执行和成果集成，并在独立的万象台桌面呈现组织与运行过程。现有工作台保持不变；一期不支持任务中动态创建预设或超过一层的预设嵌套。

产品契约、状态模型、文件安全、调度、恢复、界面和默认参数见 [完整设计记录](design-and-history.md)。该文档按具体任务需要读取，不作为进度台账。

## 批次与任务清单

| 批次 | 任务 | 状态 |
| --- | --- | --- |
| A 共同契约 | [C01 领域契约、协议与数据归属](01-C01-contracts.md) | 未开始 |
| A 共同契约 | [C02 项目级配置与来源预检](02-C02-project-config.md) | 未开始 |
| A 共同契约 | [S01 需求追溯与覆盖表](19-S01-requirement-coverage.md) | 未开始 |
| A 共同契约 | [S02 项目配置示例](20-S02-project-config-examples.md) | 未开始 |
| A 共同契约 | [S03 测试样例数据](21-S03-sample-data.md) | 未开始 |
| A 共同契约 | [S04 四类皮肤词表](22-S04-skin-vocabularies.md) | 未开始 |
| B 文件与组织 | [C03 不可变文件快照](03-C03-source-snapshots.md) | 未开始 |
| B 文件与组织 | [C04 实例工作区与执行隔离](04-C04-instance-workspaces.md) | 未开始 |
| B 文件与组织 | [C05 调度者、团队创建与角色派发](05-C05-team-creation.md) | 未开始 |
| B 文件与组织 | [C06 状态投影与增量同步](06-C06-state-projection.md) | 未开始 |
| C 协作与桌面 | [C07 讨论存储与可靠投递](07-C07-discussion-storage.md) | 未开始 |
| C 协作与桌面 | [C08 回合调度与等待处理](08-C08-discussion-scheduler.md) | 未开始 |
| C 协作与桌面 | [C09 共识、裁定与审批路由](09-C09-decision-routing.md) | 未开始 |
| C 协作与桌面 | [C15 桌面入口、状态绑定与展示契约](15-C15-desktop-foundation.md) | 未开始 |
| C 协作与桌面 | [C16 场景布局、人物移动与皮肤运行](16-C16-scenes-and-skins.md) | 未开始 |
| C 协作与桌面 | [S05 四类场景模板数据](23-S05-scene-template-data.md) | 未开始 |
| C 协作与桌面 | [S06 人物详情展示组件](24-S06-instance-details-view.md) | 未开始 |
| C 协作与桌面 | [S07 工作区准备状态组件](25-S07-workspace-status-view.md) | 未开始 |
| C 协作与桌面 | [S08 决策记录展示组件](26-S08-decision-record-view.md) | 未开始 |
| D 上下文与成果 | [C10 上下文预算、压缩与交接](10-C10-context-management.md) | 未开始 |
| D 上下文与成果 | [C11 成果冻结与交付](11-C11-deliverables.md) | 未开始 |
| D 上下文与成果 | [C12 集成、冲突与基线更新](12-C12-integration.md) | 未开始 |
| D 上下文与成果 | [C13 原项目回写与恢复](13-C13-publish.md) | 未开始 |
| D 上下文与成果 | [S09 交付列表展示组件](27-S09-delivery-list-view.md) | 未开始 |
| E 恢复与交互 | [C14 生命周期与统一恢复](14-C14-lifecycle-recovery.md) | 未开始 |
| E 恢复与交互 | [C17 会议、待办与成果的业务交互连接](17-C17-interaction-panels.md) | 未开始 |
| E 恢复与交互 | [S10 用户帮助与验收说明](28-S10-user-guide.md) | 未开始 |
| F 统一验收 | [C18 综合验证与用户验收](18-C18-final-regression.md) | 未开始 |

## 依赖与恢复检查点

- 主链：C01 -> C02 -> C03 -> C04 -> C05 -> C06；其后按各子计划声明的依赖进入协作、桌面、成果和恢复链。
- C18 依赖其余 27 项，是唯一承担浏览器/Electron 人工流程、视觉和真实设备性能验收的子计划；统一手册位于 [verify/manual-final.md](verify/manual-final.md)。
- 当前尚未实施，不得把“未解锁”记录为阻塞。下一入口为 C01 或 S01；分配前先读取对应子计划及其直接依赖，不需要枚举本目录。
- 子计划完成后将结果和验证结论写回本 README，移除链接并删除详细文件。最终 C18 通过后进入用户审批，用户明确批准后本计划标记 `已完成`。
