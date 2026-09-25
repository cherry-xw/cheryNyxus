# CheryClaw 文档中心

本文档是仓库文档的总入口。详细内容按运行边界和信息职责归档；根目录不直接堆放专题文档。

## 文档领域

| 领域 | 入口 | 对应范围 |
| --- | --- | --- |
| 后端 | [backend/](./backend/README.md) | `src/` 中的 Agent、Core、数据库、记忆、服务与工具模块 |
| 中转服务 | [relay/](./relay/README.md) | 独立中转进程、设备握手、后端发现与受限路由 |
| 前端 | [frontend/](./frontend/README.md) | `web/` 应用、工作台、设置、桌宠与 Electron 平台能力 |
| 跨端共享 | [shared/](./shared/README.md) | 前后端共同遵守的架构、协议、状态机与设备 profile |
| 质量 | [quality/](./quality/README.md) | 测试基线、流程测试与测试工具 |
| 指南 | [guides/](./guides/README.md) | 面向开发者和维护者的操作指南 |
| 开发规范 | [standards/](./standards/README.md) | 全局、后端、前端及模块级强制约束 |

实施计划统一位于 `docs/plan/`。根入口、任务 README、未完成子计划和可复用验证说明纳入版本控制，以便跨环境恢复；`verify/out/` 下的构建物、截图、日志和测试产物继续由 Git 忽略。存在活动计划时，[Plan 工作区](./plan/README.md) 是唯一总入口，每个任务以 `<task-id>/README.md` 作为任务清单与恢复入口。

## 阅读路径

1. 从上表选择问题所属领域。
2. 阅读该目录的 `README.md`，确认模块职责与权威文档。
3. 只展开当前任务需要的专题文件；跨领域事实以 `shared/` 中的契约为准。

## 按任务查找

| 我想做什么 | 先读 | 下一步 |
| --- | --- | --- |
| 修改 Agent、模型、感官、提示词或后端运行流程 | [后端文档](./backend/README.md) | 从对应模块的任务定位表进入专题、代码入口和测试 |
| 修改 Web、Electron、工作台、设置或桌宠 | [前端文档](./frontend/README.md) | 从前端模块导航和任务路由进入页面规范与代码入口 |
| 修改前后端共同遵守的协议、状态或数据模型 | [跨端共享文档](./shared/README.md) | 先确认共享契约，再进入后端或前端实现入口 |
| 修改中转服务、设备绑定或远程连接 | [中转服务文档](./relay/README.md) | 先读中转协议，再进入 relay 或前端中转连接入口 |
| 判断测试、人工验收或长期证据如何保存 | [质量文档](./quality/README.md) | 按验证类型进入测试、证据或已知问题入口 |
| 查找开发、部署或维护操作步骤 | [操作指南](./guides/README.md) | 选择对应环境或运行场景的操作卡 |
| 查找必须遵守的全局或模块规则 | [开发规范](./standards/README.md) | 先按作用域选择全局、前端或模块规范 |
| 恢复未完成的跨会话任务 | [计划总入口](./plan/README.md) | 选择任务 README，再读取当前未完成小任务 |

新增或移动文档时遵守 [文档层级规范](./standards/global/documentation-hierarchy.md)。
