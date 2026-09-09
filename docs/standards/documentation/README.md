# 通用文档管理方案

这是可整体复制到其他项目的独立规则包，包含文档内容、目录结构、计划生命周期、统一入口模板、采用指南，以及可选的计划查看与校验工具。它不包含业务目录、协作限制或验收政策；这些由每个采用项目在自己的项目配置中维护。

## 环境依赖

- **文档规则本身**：纯 Markdown，无任何环境要求，由 Agent 工具在相关操作前读取。
- **工具脚本**（`tools/` 下的计划查看与校验，可选采用）：
  - Node.js **≥ 20**（唯一依赖），仅使用内置模块，**无需 npm install**；
  - 跨平台（Windows / Linux / macOS）；仅访问 localhost；对 `docs/plan` 只读。

## 快速采用

1. 将整个 `documentation/` 目录复制到目标项目的 `docs/standards/`。
2. 将 [entry-template.md](./entry-template.md) 的模板合入目标项目根 `AGENTS.md`，替换其中的项目配置和链接。
3. 在目标项目建立项目配置，明确领域路由、验证入口、审批和产物策略。
4. 为所用 Agent 工具配置读取根 `AGENTS.md`，以新会话验证入口实际生效。
5. 按 [adoption-guide.md](./adoption-guide.md) 迁移已有文档并接入检查。
6. （可选）使用附带工具：`node docs/standards/documentation/tools/lint.mjs` 校验计划文档最低规则；`node docs/standards/documentation/tools/plan-viewer.mjs` 启动计划查看页面。工具自动向上定位 `docs/plan`，也可用 `--plan-dir` 指定。

统一入口要求在相关操作开始前按下表加载规则；已读取且未变化的规则无需重复读取。

| 操作前提 | 直接读取 |
| --- | --- |
| 新增或修改持久文档、修改代码影响持久事实 | [content.md](./content.md) |
| 新增、移动、删除或重新分类文档 | [structure.md](./structure.md) |
| 建立、维护或恢复实施计划 | [plans.md](./plans.md) |
| 给新项目配置统一入口 | [entry-template.md](./entry-template.md) |
| 老项目无文档或现有文档混乱 | [existing-project-guide.md](./existing-project-guide.md) |
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
| [tools/](./tools/README.md) | 可选工具：计划查看页面（`plan-viewer.mjs`）与计划文档校验（`lint.mjs`）的用法与校验边界 |

内容规范维护事实归属与写作验证规则，结构规范维护目录角色，计划规范维护任务状态；其他位置引用这些 owner。验证采用 Markdown 链接、锚点、路径与索引可达性检查，实际命令由项目提供。
