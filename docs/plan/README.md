# Plan 工作区

本文件是当前实施计划的唯一总入口。先在下表选择任务，再进入对应目录的 `README.md`；只有执行具体小任务时才读取其详细文档。

| 任务 | 状态 | 范围 |
| --- | --- | --- |
| [主 Agent 运行流程图](main-agent-runtime-diagram/README.md) | 待综合验证 | 流程观察与回放已实现，自动验证通过，人工验收待执行 |
| [会话归档管理](session-archive/README.md) | 待综合验证 | 设置内主子会话归档与整组永久删除 |
| [故障工业赛博工作区 V2](cyber-terminal-workspace-v2/README.md) | 待综合验证 | 赛博桌面、工作台、会话、节点树和全局动效 |
| [前端交互与颜色逻辑修正](frontend-interaction-color-audit/README.md) | 待综合验证 | 主题可读性、设置与窗口生命周期、输入和导航可靠性 |
| [多 Agent 并行任务中心](parallel-agent-task-center/README.md) | 待综合验证 | 根会话任务聚合、待办上下文、增量同步和轮询移除 |
| [任务中心 UI 修正与旧待操作退役](task-center-ui-correction/README.md) | 待综合验证 | 任务中心视觉修正和旧入口清理 |
| [万象台](wanxiangtai/README.md) | 规划中 | 多 Agent 团队协作、独立工作区、交付集成与桌面呈现 |
| [Web 桌面回归修复](web-desktop-regressions/README.md) | 待综合验证 | 工作区、设置及 Pet 既有交互契约恢复 |

## 使用规则

小型即时任务按 [Plan 适用范围](../standards/global/plan-operation.md#0-是否需要建立计划) 直接完成，无需在此登记。

- 本页只维护任务目录、当前状态和一句话范围，不复制任务清单。
- 每个任务目录的 `README.md` 是该任务唯一恢复入口，详细小任务与验证资产只从那里进入。
- 新建或维护任务文档时，按[创建时间规则](../standards/documentation/plans.md#11-文档创建时间)在任务名称下记录文档创建时间。
- 完成的小任务删除独立文档，结果摘要保留在任务 README；人工/UI 验证只放在最后的综合验证子计划。
- 新建、完成、暂停或恢复任务时同步本页状态。所有内容遵守 [Plan 操作方案](../standards/global/plan-operation.md)。
