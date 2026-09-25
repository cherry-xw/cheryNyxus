# 通用文档管理方案

这是可整体复制到其他项目的独立规则包，包含文档内容、目录结构、计划生命周期、统一入口模板和采用指南。它不包含业务目录、工具命令、协作限制或验收政策；这些由每个采用项目在自己的项目配置中维护。

## 快速采用

1. 将整个 `documentation/` 目录复制为目标项目的 `docs/standards/documentation/`，保留包内相对链接。
2. 将 [entry-template.md](./entry-template.md) 的模板合入目标项目根 `AGENTS.md`，替换其中的项目配置和链接。
3. 按[统一入口模板](./entry-template.md)项目配置区的必填项逐项填写；该清单是项目配置的唯一定义，本文不重复列举。
4. 为所用 Agent 工具配置读取根 `AGENTS.md`，以新会话验证入口实际生效。
5. 按 [adoption-guide.md](./adoption-guide.md) 迁移已有文档并接入检查。

统一入口要求在相关操作开始前按下表加载规则；已读取且未变化的规则无需重复读取。

| 触发操作 | 操作前读取 |
| --- | --- |
| 编写持久文档或代码变更影响持久事实 | [content.md](./content.md) |
| 新增、移动、删除或重新分类文档 | [structure.md](./structure.md) |
| 建立、维护或恢复实施计划 | [plans.md](./plans.md) |
| 项目尚无文档入口，或现有文档无法可靠定位 | [existing-project-guide.md](./existing-project-guide.md) |
| 复制、部署、迁移或升级本方案 | [adoption-guide.md](./adoption-guide.md) |

| 文件 | 作用 |
| --- | --- |
| `README.md` | 包入口与快速采用说明 |
| [content.md](./content.md) | 事实归属、任务定位、内容压缩与维护要求 |
| [structure.md](./structure.md) | 目录角色、导航和文档生命周期 |
| [plans.md](./plans.md) | 实施计划、恢复、验证和收口 |
| [entry-template.md](./entry-template.md) | 根 `AGENTS.md` 可复制模板 |
| [adoption-guide.md](./adoption-guide.md) | 迁移、检查、评估和升级步骤 |
| [existing-project-guide.md](./existing-project-guide.md) | 无文档或文档混乱的存量项目梳理流程 |

## 文件与规则归属

同一规则只在其 owner 文件中定义，其他文件只引用，不复述；升级或修改规则包时按下表定位应修改的位置。

| 文件 | 作用 | 独占维护的规则 |
| --- | --- | --- |
| `README.md` | 包入口、快速采用说明 | 术语约定、规则归属表 |
| [content.md](./content.md) | 内容规范：事实归属、任务定位、内容压缩与维护要求 | 导航层级与四跳要求、事实冲突优先级、单一事实源、来源与生成内容、内容压缩、代码定位、变更同步矩阵、写作评审、自动化检查项 |
| [structure.md](./structure.md) | 结构规范：目录角色、导航和文档生命周期 | 文档角色与默认位置、生成文档、外部来源镜像、兼容跳转页、归档、文档增删移动时的同步 |
| [plans.md](./plans.md) | 计划规范：实施计划、恢复、验证和收口 | `docs/plan/` 结构与版本控制边界、任务状态、收口、验证资产分类、用户审批 |
| [entry-template.md](./entry-template.md) | 根 `AGENTS.md` 可复制模板 | 统一入口的执行基线、项目配置的定义与必填项 |
| [adoption-guide.md](./adoption-guide.md) | 迁移、检查、评估和升级步骤 | 无，只引用规范 |
| [existing-project-guide.md](./existing-project-guide.md) | 无文档或文档混乱的存量项目梳理流程 | 无，只引用规范 |

## 术语约定

包内统一使用以下名称，不使用同义变体：

| 术语 | 含义 |
| --- | --- |
| 统一入口 | 目标项目根 `AGENTS.md`，属于[内容规范](./content.md)第 2 节的 L0 项目入口 |
| 项目配置 | 统一入口中的“项目配置”区，定义与必填项见 [entry-template.md](./entry-template.md) |
| 项目协作规范 | 采用项目自有的提交与协作政策，由项目配置链接，本包不定义其内容 |
| 文档总索引 | `docs/README.md`，完整领域导航，即 L1 |
| 领域 README、模块入口、专题文档 | 分别对应 L2、L3、L4 |
| 计划总入口 | `docs/plan/README.md` |
| 总任务 README | `docs/plan/<task-id>/README.md` |
| 小任务文档 | `docs/plan/<task-id>/<subtask>.md`，只在小任务未完成时存在 |
| 权威源文档 | 人工维护、能够独立证明当前事实的文档；其他页面只能引用它 |
| 生成文档 | 由源文件和固定命令产生的文档；生成结果不是事实 owner，不得手改 |
| 外部来源镜像 | 从其他仓库或外部来源同步的本地副本；必须记录来源和同步方式，不得在镜像处改事实 |
| 兼容跳转页 | 只把旧路径导向新 owner 的页面；不承载第二份正文，引用迁移完成后删除 |
| 手动验证 | 无法由自动验证替代的验证事项；其范围由项目配置中的人工验收边界规定 |

验证采用 Markdown 链接、锚点、路径与索引可达性检查，实际命令由项目提供。
