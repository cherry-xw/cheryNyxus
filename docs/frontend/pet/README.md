# Pet 桌宠与 Nyxus 模块

本目录对应 [桌宠功能源码](../../../web/src/features/pets/) 与 [桌宠领域模型](../../../web/src/domain/pets/)。它维护桌宠的状态、运动和渲染，以及 Nyxus 节点树工作台的前端说明。跨前后端 Agent 编排事实以 [Agent 编排架构](../../shared/architecture/agent-orchestration.md) 为准。

## 文档导航

| 文档 | 内容 |
| --- | --- |
| [model.md](./model.md) | Pet 数据结构、预设与实例创建 |
| [state.md](./state.md) | 情绪、疲劳、休息与唤醒状态 |
| [movement.md](./movement.md) | 舞台移动、拖拽、目标选择和边界约束 |
| [motion.md](./motion.md) | GSAP 动画描述与执行 |
| [rendering.md](./rendering.md) | 组件分层、气泡、图标和视觉层级 |
| [style.md](./style.md) | Pet 样式组织方式 |
| [agent-integration.md](./agent-integration.md) | Pet 与 Agent 会话、通知及历史的集成 |
| [nyxus-node-tree-maintenance.md](./nyxus-node-tree-maintenance.md) | Nyxus 节点树的边界、迁移和维护约束 |
| [运行流程图](../runtime-diagram.md) | 工作台只读流程、双视口布局和历史回放 |

## 源码边界

| 路径 | 职责 |
| --- | --- |
| [web/src/domain/pets/](../../../web/src/domain/pets/) | 与 UI 无关的类型、预设、工厂和运动纯函数 |
| [web/src/features/pets/components/](../../../web/src/features/pets/components/) | Pet 舞台与可视组件 |
| [web/src/features/pets/composables/](../../../web/src/features/pets/composables/) | 交互、动画和生命周期编排 |
| [web/src/features/pets/nyxus/](../../../web/src/features/pets/nyxus/) | Nyxus 入口、节点树、纸牌视图和粒子渲染 |
| [web/src/stores/agents/](../../../web/src/stores/agents/) | Agent 会话及前端投影 |
| [web/src/stores/pets/](../../../web/src/stores/pets/) | Pet 展示状态 |

新增主题先判断是否能并入现有专题；只有形成独立职责后才新增文件，并同步更新本索引。
