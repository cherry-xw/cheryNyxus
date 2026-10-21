# 共享架构

| 文档 | 定位 |
| --- | --- |
| [canonical-timeline.md](./canonical-timeline.md) | 多 Agent 权威时间线、投影、分页和恢复语义的当前规范 |
| [agent-orchestration.md](./agent-orchestration.md) | 主从 Agent、Chat 与 Pet 的跨端编排和生命周期 |
| [context-epochs.md](./context-epochs.md) | 配置修订、上下文纪元、归档和删除生命周期 |
| [authentication-flows.md](./authentication-flows.md) | 各端登录、账号绑定、发现、转发、恢复的实际流程、数据交换与用户体验缺口 |
| [relay-gateway-requirements.md](./relay-gateway-requirements.md) | 中转统一 Pocket ID、后端密码、本机直连与后端发现的目标需求 |
| [qqbot-platform.md](./qqbot-platform.md) | NapCat 插件、Docker 后端的边界、部署、迁移和验收 |
| [ingress-plugins.md](./ingress-plugins.md) | 统一插件宿主：接口版本 2 契约、可信请求视图、生命周期及验证入口 |
| [manager-plugins.md](./manager-plugins.md) | Manager 动态页面、HTTP、资源认证及双端状态 |
| [manager-management.md](./manager-management.md) | Manager 能力与 QQ 管理接口、资源保存和失败边界 |
| [cheryNyxus-components.md](./cheryNyxus-components.md) | cheryNyxus 后端、Manager、Backend 插件与 NapCat 插件的职责边界及统一命名 |
| [repository-structure.md](./repository-structure.md) | 仓库顶层目录按后端、Manager、业务插件和平台适配分类的建议；记录技能、开发工具、脚本与 relay 的归属边界 |

实现过程和阶段编号不应成为这些文档的主体；完成后的稳定结论应改写为当前架构事实。

- [后续架构改善候选](issues.md)：尚未实施的改善建议，不影响已验收需求收口。
