# 故障工业赛博工作区 V2：需求、实现路径与复盘结论

> 用途：作为重新分析的事实基线。本文总结已提交的实现和已知验证结果，不替代仍保留在 `docs/plan/cyber-terminal-workspace-v2.md` 的执行计划。

## 1. 任务概述

本任务将 Web 主界面重构为“故障工业赛博 OS”风格的多窗口桌面，并升级工作台（会话节点树）为横向 Signal Grid。实现提交为 `143af38e3e2b142d049554f53df1923e63b7a139`（`feat(web): complete cyber workbench overhaul`）。

核心约束是“只重构前端表现层与 UI 状态，不改变业务事实和协议”：不得修改 `packages/protocol`、服务端、RPC、canonical state，既有发送、附件、审批、提问、历史、设置及 Electron IPC 必须继续可用。

## 2. 原始需求归纳

| 领域 | 需求 | 边界/验收意图 |
| --- | --- | --- |
| 桌面与窗口 | 浏览器端从单页面/抽屉式界面改为自定义赛博桌面，提供系统栏、任务栏、窗口层叠、聚焦、最小化、拖拽、缩放、最大化和布局恢复。 | 浏览器仅由 `CyberWindow` 拥有功能窗外壳；Electron 仅由 `WindowFrame` 拥有原生窗外壳，独立 Overlay 保持既有外壳。 |
| 会话及辅助界面 | 会话、路由、角色、待操作、历史、设置、登录/断线等功能进入统一视觉语言。 | 不能复制会话事实，也不能改 submit/interaction 等业务命令。 |
| 节点树 | 默认使用横向 Signal Grid，保留纵向 Classic 与卡片模式；两种图模式的节点、边、选择、操作语义一致。 | 不重写图谱拓扑、lane、fold 或 canonical graph。 |
| 节点信息层级 | 每轮首条用户消息、末条模型回复、错误为核心信息；过程节点弱化。 | Hero/错误/折叠/普通节点采用不同几何、LOD、命中区与连线端口。 |
| 旗舰交互 | 节点故障/状态动效、折叠卫星轨道、节点检查器、TREE/LITE 切换和待操作控制台需要成为完整工作台体验。 | 不新增第二动画库、第二 Pixi renderer 或 ticker；审批、提问、发送命令保持不变。 |
| 视觉与可访问性 | 深浅主题、reduced-motion、forced-colors 下保持可读；全前端表面统一赛博动效语言。 | 强动效必须可降级、可清理；核心内容不能因 ScrambleText/故障效果而不可访问。 |
| 性能 | 在 1920×1080 Iris Xe / Radeon 780M 基准环境中，30 秒平均 FPS 不低于 30。最终高质量交互目标为 60 FPS。 | 需覆盖 Web 与 Electron 的实机视觉、缩放、FPS、ticker/primitive 和资源清理。 |

## 3. 需求在实施中的两次关键收敛

1. **窗口外壳唯一所有权。** 人工核验发现 Agent、History、Settings 在 `CyberWindow` 内仍渲染旧标题栏、边框或固定尺寸，形成“双壳”。因此将它们拆为无壳 `embedded` 内容：浏览器功能窗只由 `CyberWindow` 包裹，内容必须铺满且允许收缩；History 的下钻返回能力保留。
2. **节点树不只做横向排布。** 人工核验认为早期 Signal 方案只完成横向化和简单造型，未达到旗舰交互预期。任务据此扩展为窗口统一、核心消息层级/变量几何、故障动效、卫星轨道、可缩放检查器、TREE/LITE 与待操作控制台，以及全前端动效统一。

## 4. 实现路径与架构决策

### 4.1 基线先行

先锁定协议、application port 和核心流程，并以测试确保协议、后端、数据库不发生代码变更。这样 UI 重构中的问题不会被误归因到业务语义变化。

### 4.2 用 UI-only 窗口模型承载桌面能力

新增 Workspace 窗口注册表和纯窗口模型（类型、几何、层级、焦点、最小化、最大化、恢复、持久化及清理），业务数据仍留在既有 canonical state。浏览器由 `CyberDesktopHost` 统一装配，`CyberWindow` 负责功能窗外壳和交互；原生 Electron surface 的路由与 IPC 不变。

关键落点：

- `web/src/stores/workspace/windowModel.ts`
- `web/src/stores/workspace/windowPersistence.ts`
- `web/src/features/desktop/CyberDesktopHost.vue`
- `web/src/features/desktop/CyberWindow.vue`

### 4.3 将既有能力迁入窗口，而不是重写能力

Agent、History、Settings、Capability 和 Diagnostic 等内容拆分为“壳”和“内容”。Web 中以嵌入态进入 `CyberWindow`，移除重复的标题栏、固定尺寸和窗口控制；Electron/Overlay 保留其必要的独立表面。这一做法消除了双壳，也避免业务控制器或命令链重写。

### 4.4 节点树采用“展示投影”而非改写图事实

保留原布局与拓扑事实，在其之后建立 Signal/Classic presentation 投影。Signal 将坐标和路由映射为水平主线，重算 bounds、端口和画布范围；Renderer 根据投影绘制切角节点、水平 Fiber Bus、脉冲和分级 LOD。Signal 初始化异常时自动回退 Classic。

关键落点：

- `web/src/features/pets/nyxus/graph/executionPresentation.ts`
- `web/src/features/pets/nyxus/graph/executionGeometry.ts`
- `web/src/features/pets/nyxus/renderer/ExecutionGraphPixiRenderer.ts`

### 4.5 用信息优先级驱动几何和交互

将每轮首个用户节点、最终模型回复和错误节点定义为高优先级：近景显示摘要，中景保留协议码，远景只保留图形；过程节点降低视觉权重。变量宽度的视觉 bounds 同时驱动列距、连线端口、命中区和浮层锚点，避免“画面位置”和“可点击位置”不一致。

### 4.6 用单一动效/渲染预算控制复杂度

GSAP 只用于 DOM 时间线，Pixi 保持同一 Application/ticker。节点特效、窗口动效、Lite 扫描和桌面事件均接入已有 motion/quality 降级，并要求 scope 和销毁清理。折叠入口从数字标签改为三层卫星轨道；详情从 hover 浮层升级为可固化、拖动、八向缩放、可钳制的检查器。

### 4.7 统一工作台和全局视觉语言

Web 工作台迁入通用 `CyberWindow`，并使 TREE/LITE、待操作 Interrupt Console、节点状态和协议图标共享同一套 chrome、状态色、动效和 reduced-motion 规则。最后将这套窗口与事件动效扩展至会话、历史、设置、能力窗、诊断窗、桌面及 Pet/Nyxus 舞台。

## 5. 已完成的实施范围

实现共修改 61 个 Web 文件，新增约 4,085 行、删除约 764 行。主要成果如下：

- 赛博桌面、功能窗口、系统栏/任务栏/进程轨及窗口状态持久化。
- Web 工作台统一窗口壳，支持安全区内最大化/恢复、标题栏操作和嵌入内容。
- Agent、History、Settings 等嵌入态去壳，解决重复边框和固定尺寸问题。
- Signal/Classic/卡片三种节点树展示模式，含方向感知导航、尾端跟随、详情与 CRT 锚定、Signal 回退。
- 核心消息优先级、变量节点几何、分级标签和连线/命中区同步。
- 错误崩坏、用户投射、回复收束、过程残像等节点动效；折叠卫星轨道。
- 可固化、可拖动缩放的节点检查器，及对长行、深浅主题和 forced-colors 的处理。
- `TREE // LITE` 分段切换、Lite 视觉、Interrupt Console 与跨表面统一动效。
- 针对窗口模型、嵌入外壳、视觉事件、展示投影、检查器、渲染质量和分包边界补充自动化测试。

## 6. 验证事实与未完成项

### 已完成的自动化验证

- 任务 13–16 的交叉定向集：74/74 通过。
- Web 全量测试：87 个测试文件、497/497 通过。
- 后端全量测试：139 个测试文件、1,186 通过，2 项既有跳过。
- 协议测试：后端 415/415、Web 8/8 通过。
- 后端与 Web TypeScript 检查、Web/Electron 生产构建、`git diff --check` 均通过。
- 修改文件的定向 ESLint：0 error、7 warning。全仓 lint 不作为本任务门禁，因为存在 67,795 个既有 CRLF/Prettier 错误，未对此进行无关的大规模格式化。

### 未完成的人工/实机验证

- 深色、浅色、reduced-motion、forced-colors 视觉矩阵。
- Web：1920×1080、1366×768、1024×768 的交互验收。
- Electron：100% 与 150% 缩放、原生表面的验收。
- 高质量/平衡档的 FPS、活跃 primitive、ticker 数量及资源清理证据。

未完成原因是当前执行环境没有浏览器控制入口，无法可信地执行截图、点击、Electron 缩放或 GPU/FPS 采集；不应用静态检查冒充实机验收。

## 7. 结论与重新分析建议

### 当前结论

实现层面已完成预定的前端架构与交互改造，并已提交；协议和业务命令未被纳入改造范围，自动化回归均通过。**但任务尚不能宣称最终完成或已获用户验收**：视觉矩阵、不同分辨率/缩放下的可用性，以及性能目标仍缺少实机证据。

### 建议优先重新审视的决策

1. 确认“赛博 OS 多窗口”是否仍是产品主路径，还是只保留为桌面宽屏模式；它直接影响小屏与 Electron 的复杂度。
2. 明确 Signal Grid 的信息密度目标：核心三类消息是否足够、过程节点是否需要在更多场景展开，避免视觉层级损害调试可追溯性。
3. 审查卫星轨道和可缩放检查器的发现性与键盘可达性，特别是折叠数量较多、窗口较窄时。
4. 以真实目标设备补齐性能门槛：先记录 6 个固定场景，再决定是否继续降低动画、primitive 或节点 LOD。
5. 将人工视觉验收拆为“窗口壳/布局”“节点树交互”“动效与无障碍”“Electron 原生表面”四组，任何一组失败都应重新打开对应实现项，而不是只调整样式。

## 8. 关联材料

- 原执行计划：[`docs/plan/cyber-terminal-workspace-v2.md`](../plan/cyber-terminal-workspace-v2.md)
- 节点树模块说明：[`docs/web/pet/README.md`](pet/README.md)
- 视觉与交互规范：[`docs/standards/ui-visual-and-interaction.md`](../standards/ui-visual-and-interaction.md)
- 动效规范：[`docs/web/motion-standard.md`](motion-standard.md)

