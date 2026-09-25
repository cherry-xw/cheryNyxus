# 开发规范

本目录只维护可复用、可审查、可强制执行的约束。功能事实和实现说明属于对应模块文档。

| 目录 | 适用范围 |
| --- | --- |
| [documentation/](./documentation/README.md) | 可跨项目迁移的文档标准、入口模板与采用指南 |
| [global/](./global/README.md) | 本项目全局协作政策、文档配置与历史入口 |
| [frontend/](./frontend/README.md) | `web/` 的架构、页面构建和视觉交互规则 |
| [modules/](./modules/README.md) | 仅对指定业务模块生效的长期约束 |

新增规则应放入最小适用范围。只有确实跨越多个模块时才进入 `global/`。

## 按任务查找

| 我需要确认什么 | 先读 |
| --- | --- |
| 文档怎么定位、归属、迁移和检查 | [通用文档规则](./documentation/README.md) |
| 项目路径、计划审批、证据和人工验收边界 | [全局规范](./global/README.md) |
| 前端依赖方向、页面结构和视觉交互 | [前端规范](./frontend/README.md) |
| Agent 模块的特殊强制约束 | [模块规范](./modules/README.md) |
