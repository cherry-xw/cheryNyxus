# Plan 工作区

本文件是当前实施计划的唯一总入口。先在下表选择任务，再进入对应目录的 `README.md`；只有执行具体小任务时才读取其详细文档。

| 任务                                                                           | 状态       | 范围                                                           |
| ------------------------------------------------------------------------------ | ---------- | -------------------------------------------------------------- |
| [受管工作容器与小应用运行](managed-app-runtime/README.md) | 待综合验证 | 受限容器、固定依赖、发布与删除已部署；资源异常、协议和真实 QQ 操作仍需综合验收 |
| [ADV 客户端](adv-client/README.md) | 执行中 | 输入、显示、存储与联网底座部分实现；音频、业务通信及实机验收未完成，本次不提交固件改动 |
| [万象台](wanxiangtai/README.md)                                                | 规划中     | 多 Agent 团队协作、独立工作区、交付集成与桌面呈现              |
| [上下文统计、待办进度与连续消息交互](conversation-observability-and-input/README.md) | 规划中 | 上下文统计、待办进度与连续消息交互的设计初稿；另含已确认的上下文预算与 QQ 讨论总结专题及其实施状态。 |
| [文件能力与多模型协作](file-capabilities-and-model-collaboration/README.md) | 执行中 | 原范围继续验收；服务端记录、解析、保存与工具卡已接通，配置验证状态、图片输入选择及完整恢复仍需完成 |

## 使用规则

小型即时任务按 [Plan 适用范围](../standards/global/plan-operation.md#0-是否需要建立计划) 直接完成，无需在此登记。

- 本页只维护任务目录、当前状态和一句话范围，不复制任务清单。
- 每个任务目录的 `README.md` 是该任务唯一恢复入口，详细小任务与验证资产只从那里进入。
- 新建或维护任务文档时，按[创建时间规则](../standards/documentation/plans.md#11-文档创建时间)在任务名称下记录文档创建时间。
- 小任务和总任务收口遵守[计划规范](../standards/documentation/plans.md)；当前未完成条件、验证方法和必要用户验收必须保持准确。
- 验证资产维护当前范围、前提和操作方法，不保留AI实施流水、旧任务编号或历次输出台账。原始执行输出和历史审批记录保存在仓库外或任务系统，不强制迁入Markdown历史目录。
- 删除已完成计划前核实验收与批准要求，回写仍有效的契约、方法和导航；不能以清理历史为由跳过真实验收，也不能保留失效文件引用。
- 新建、完成、暂停或恢复任务时同步本页状态。所有内容遵守 [Plan 操作方案](../standards/global/plan-operation.md)。

## 结束，已归档

- 需求设计与实施协作流程：**结束，已归档**。正式规范见[需求设计规范](../standards/documentation/requirements-design.md)与[项目协作规范](../standards/global/ai-collaboration.md)，分发入口见[文档工具](../standards/documentation/tools/README.md)。实际跨模型效果与成本不属于本次文档交付的验证范围。

- 当前视频下载相关：**结束，已归档**。正式说明见[QQ模块](../../plugins/qq/README.md#媒体下载与清理)。
- QQ对话理解与语音设置：**结束，已归档**。正式说明见[QQ对话与语音](../../plugins/qq/README.md#对话与语音)。
- Manager管理插件与管理交互：**结束，已归档**。正式说明见[Manager插件](../shared/architecture/manager-plugins.md)。
- 后端目录与配套启动：**结束，已归档**。正式说明见[后端运行](../guides/backend-runtime.md)。
- QQ 群图片上下文：**结束，已归档**。正式说明见[QQ 协议](../shared/protocol/qqbot-plugin.md#原生图片采集)与[模型能力](../backend/agent/model-capabilities.md)；未验证项归入[后续审核清单](../quality/verification/qq-safe-outcomes.md)。
- QQ 错误说明与受控问答续接：**结束，已归档**。正式说明见[错误规范](../shared/protocol/errors.md#qq-安全错误事实)与[QQ 模块](../../plugins/qq/README.md#受权限约束的问题与暂停)；外围边界归入[后续审核清单](../quality/verification/qq-safe-outcomes.md)。
- Manager 平台化与 Backend 启动监控（第一阶段）：**结束，已归档**。正式说明见[Manager 管理架构](../shared/architecture/manager-management.md)、[Manager 插件](../shared/architecture/manager-plugins.md)与[后端运行](../guides/backend-runtime.md)；待人工界面审核项归入[后续审核清单](../quality/verification/qq-safe-outcomes.md)。
- Agent 命令监控与 Backend 停止（第二阶段）：**结束，已归档**。正式说明见[Manager 管理架构](../shared/architecture/manager-management.md)、[后端服务](../backend/service/README.md)、[Drain 日志摘要](../backend/utils/drain.md)与[QQ 协议](../shared/protocol/qqbot-plugin.md#服务停止与空队列恢复)；待生产部署与人工界面审核项归入[后续审核清单](../quality/verification/qq-safe-outcomes.md)。

上述任务按用户确认结束，临时计划与验收材料已删除；有效说明归正式模块，结束状态不代表所有已记录限制均已修复。
