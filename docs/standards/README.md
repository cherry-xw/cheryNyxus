# 开发规范

本目录只维护可复用、可审查、可强制执行的约束。功能事实和实现说明属于对应模块文档。

| 目录 | 适用范围 |
| --- | --- |
| [documentation/](./documentation/README.md) | 可跨项目迁移的文档标准、入口模板与采用指南 |
| [global/](./global/README.md) | 本项目全局协作政策、文档配置与历史入口 |
| [frontend/](./frontend/README.md) | `web/` 的架构、页面构建和视觉交互规则 |
| [modules/](./modules/README.md) | 仅对指定业务模块生效的长期约束 |

新增规则应放入最小适用范围。只有确实跨越多个模块时才进入 `global/`。
