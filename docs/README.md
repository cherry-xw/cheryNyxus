# CheryClaw 文档中心

本文档是仓库文档的总入口。详细内容按运行边界和信息职责归档；根目录不直接堆放专题文档。

## 文档领域

| 领域 | 入口 | 对应范围 |
| --- | --- | --- |
| 后端 | [backend/](./backend/README.md) | `src/` 中的 Agent、Core、数据库、记忆、服务与工具模块 |
| 前端 | [frontend/](./frontend/README.md) | `web/` 应用、工作台、设置、桌宠与 Electron 平台能力 |
| 跨端共享 | [shared/](./shared/README.md) | 前后端共同遵守的架构、协议、状态机与设备 profile |
| 质量 | [quality/](./quality/README.md) | 测试基线、流程测试与测试工具 |
| 指南 | [guides/](./guides/README.md) | 面向开发者和维护者的操作指南 |
| 开发规范 | [standards/](./standards/README.md) | 全局、后端、前端及模块级强制约束 |

实施计划统一位于 `docs/plan/`。根入口、任务 README、未完成子计划和可复用验证说明纳入版本控制，以便跨环境恢复；`verify/out/` 下的构建物、截图、日志和测试产物继续由 Git 忽略。存在活动计划时，`docs/plan/README.md` 是唯一总入口，每个任务以 `<task-id>/README.md` 作为任务清单与恢复入口。

## 阅读路径

1. 从上表选择问题所属领域。
2. 阅读该目录的 `README.md`，确认模块职责与权威文档。
3. 只展开当前任务需要的专题文件；跨领域事实以 `shared/` 中的契约为准。

新增或移动文档时遵守 [文档层级规范](./standards/global/documentation-hierarchy.md)。
