# 项目统一入口

## 通用文档执行基线

以下基线在开始任务时适用。通用规则包位于 [docs/standards/documentation/](docs/standards/documentation/README.md)。

- 相关操作开始前按下表读取规范，并根据项目路由读取目标领域或模块文档；不得在任务结束后才补读。已读取且未变化的内容无需重复读取。
- 修改代码前先判断持久文档影响；契约、边界、稳定入口、关键流程、依赖、扩展方式或验证入口变化时，先更新权威说明。纯局部实现变化无需制造文档改动。
- 按“任务意图 → 权威模块文档 → 实现路径与关键符号 → 验证入口”定位。每项事实只有一个 owner，其他文档链接引用。
- README 保持简洁；模块入口说明职责、任务定位、关键流程、依赖、扩展点和验证方式。不复制源码、易变文件树或修复流水账，不以行号作为唯一定位。
- 文档变更同步最近索引与引用，检查本地链接、路径、可达性及计划跟踪状态。
- 小型、明确且能一次完成的任务无需 Plan。需要拆分、跨会话恢复或持续跟踪时建立计划；恢复时先读计划总入口，再读任务 README 和选定子任务，不先枚举整个计划目录。

| 触发操作 | 操作前直接读取 |
| --- | --- |
| 编写或修改持久文档，或代码变更影响持久事实 | [内容与维护规范](docs/standards/documentation/content.md) |
| 新增、移动、删除或重新分类文档 | [目录与生命周期规范](docs/standards/documentation/structure.md) |
| 建立、维护或恢复实施计划 | [计划规范](docs/standards/documentation/plans.md)及[项目计划政策](docs/standards/global/project-documentation.md#2-计划政策) |
| 给其他项目采用本方案 | [采用指南](docs/standards/documentation/adoption-guide.md)及[入口模板](docs/standards/documentation/entry-template.md) |
| 老项目没有文档，或现有文档无法可靠定位 | [存量项目梳理指南](docs/standards/documentation/existing-project-guide.md) |

## 项目配置：CheryClaw

以下稳定路由由本区维护，领域变化时同步文档总索引。直接进入目标 README；范围不明时读取 [docs/README.md](docs/README.md)，无需先枚举目录。

| 任务范围 | 文档入口 |
| --- | --- |
| `src/` 中的 Agent、Core、数据库、记忆、服务与工具 | [`docs/backend/`](docs/backend/README.md) |
| `web/`、工作台、设置、桌宠与 Electron | [`docs/frontend/`](docs/frontend/README.md) |
| 前后端共同遵守的架构、协议、状态机与数据模型 | [`docs/shared/`](docs/shared/README.md) |
| 测试基线、流程测试、测试工具与验证边界 | [`docs/quality/`](docs/quality/README.md) |
| 面向开发者和维护者的操作步骤 | [`docs/guides/`](docs/guides/README.md) |
| 可复用的强制约束 | [`docs/standards/`](docs/standards/README.md) |
| 需要拆分、恢复或持续跟踪的实施任务 | [`docs/plan/`](docs/plan/README.md) |

实施计划统一写入 `docs/plan/`。本项目的目录映射、计划审批与保留政策、验证边界由[项目文档配置](docs/standards/global/project-documentation.md)维护；相应操作前读取。提交或图片验证前读取 [AI 协作规范](docs/standards/global/ai-collaboration.md)。前端和模块任务在实现前从[规范总入口](docs/standards/README.md)选择适用约束。

以下约定仅属于本项目，不随通用文档包迁移。

## 语音输入纠正

用户经常使用语音输入。在整个项目中，请按以下规则理解可能出现的语音识别替换：

- “绘画”通常指“会话”。
- “节点数”指“节点树”。
- “nexus”就是“nyxus”

默认应用这些纠正。如果上下文明确与纠正后的含义冲突，请向用户确认其真实意图。

## 交互设计理解

实现交互前，应从完全不了解系统的首次用户角度进行评估。目标是“界面上可见的信息足以让用户理解”。

对于每个信息区域或操作区域，确保界面能够直接说明相关内容，或提供明显易用的了解途径：

- 内容代表什么，以及它隐藏的系统影响；
- 用户做出预期决策所需的全部上下文；
- 完成交互所需的全部信息和输入。

如果这些信息不适合直接展示在页面中，请提供清晰且容易找到的详情入口或帮助入口，确保用户无需猜测即可完成流程。
