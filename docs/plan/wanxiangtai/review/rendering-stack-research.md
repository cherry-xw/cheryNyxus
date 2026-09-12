# 万象台渲染栈「可复用组件/框架」聚焦调研

**文档创建时间：** 2026-09-12T16:05:26+08:00

**状态：** 评审补充调研（针对用户对"可复用组件/框架"诉求的聚焦调研；不推翻 D14/D15/D16/D17，选库在既有分层架构内进行）

> 前置结论：本报告是 [tech-stack-research.md](./tech-stack-research.md) 领域 4 与 [design-review.md](./design-review.md) ⑫ 的**补充深化**——从"该领域技术选型"下沉到"每个绘制元素能否找到 Vue Flow 级即用组件"。调研方法：按六大绘制元素逐领域 web_search（每领域 2～4 候选），stars 以 star-history 镜像或第三方聚合页检索为准（标注"2026-09 检索"），估算值明确标注"估计"。未读取任何 node_modules 内容。
> 星级硬门槛执行：优先 ≥10k；5k～10k 仅当该品类事实标准；<5k 一律不推荐。

---

## 开篇：以 Vue Flow 为标杆的总体结论

用户的问题："像工作台节点树从手绘 Canvas 换成 Vue Flow 那样，桌面上每块具体绘制内容，Vue Flow 级可复用方案分别是什么？"

**一句话回答：万象台不存在"一整块手绘画布"可以整体换掉——人物层本就是 DOM 组件（pet 复用），缺的是"动画、定位、连线、浮层"这些点状能力。结论是"逐点选库 + 薄自写层"，其中 5 类元素有 ≥10k 热度的即用库可直接复用，2 类元素（氛围层、连线端点同步）业界没有达标库、必须自写。**

| 绘制元素 | Vue Flow 级方案是否存在 | 结论 |
| --- | --- | --- |
| 人物移动动画（离席制状态机驱动） | ✅ 有（多个 ≥10k） | **直接采用** GSAP（timeline 最贴合），anime.js v4 / Motion 为备选 |
| 锚点拖拽 | ✅ 有（≥10k） | **直接采用** moveable + vue3-moveable；最薄用 `@vueuse/useDraggable` |
| 气泡/信息浮层定位与箭头 | ✅ 有（≥10k） | **直接采用** `@floating-ui/vue`（官方绑定）；样式仍复用现有 pet 组件 |
| 角色动效资产（二期增强） | ✅ 有（≥10k） | **二期可选** lottie-web（首选）；Rive 状态机契合但 stars 处于 5k 档边缘 |
| 平移缩放 | ⚠️ 有库无组件 | panzoom / d3-zoom 是"库"非"组件"，仍需自接 DOM/canvas；**最薄 = CSS transform 自写** |
| 氛围层（连线/粒子/涟漪/光效） | ❌ 无 | 场景图引擎（Konva/PixiJS）是"交互画布"品类，对"无交互纯装饰"层过重；**维持一期原生 Canvas 2D 自写**（与既有结论一致） |
| 讨论连线（DOM 人物 ↔ Canvas 端点） | ❌ 品类无 ≥10k 活跃库 | leader-line（唯一事实标准）2021 年后停维；且连线按 D14 本就画在 Canvas 层；**必须自写最薄同步** |

与"工作台换 Vue Flow"的本质差异：Vue Flow 换掉的是**一整块交互画布**；万象台的对应物是 Canvas 氛围层，而氛围层"无交互、纯装饰、业务不等待动画"（D14、§9 设计约束），场景图引擎的交互/命中能力恰好用不上。所以**不要**为氛围层寻找"桌面画布框架"，那是品类错配。

---

## 1. 舞台/场景画布渲染（氛围层：连线、粒子、涟漪、光效）

### 1.1 候选对比

| 库 | stars（2026-09 检索） | 维护状态 | 许可证 | Vue 3 集成 | 贴合度 | 源码修改风险点 |
| --- | --- | --- | --- | --- | --- | --- |
| **Konva** | ≈14.7k（star-history 镜像） | 活跃，v10（2025-2026 持续发版） | MIT | **官方 vue-konva**（Vue 3 声明式） | 中：交互型 2D 场景图，命中/事件是核心卖点；本层恰好不需要 | 低：纯装饰层无需改其源码 |
| **PixiJS** | ≈48.1k（star-history 镜像） | 活跃，v8.20（2026，WebGPU/WebGL） | MIT | 社区 vue3-pixi（声明式渲染器） | 中偏高（性能天花板）但体积/上下文开销大 | 中：渲染器级集成，迁移是整层替换 |
| **Phaser** | ≈40.2k（star-history 镜像） | 活跃，v4 已进入正式下载（2025-2026） | MIT | 无官方绑定，手写生命周期封装 | 低：游戏引擎（场景/物理/输入），非 UI 画布 | 高：引擎侵入性强，改源码代价大 |
| **Fabric.js** | ≈29k（估计） | 活跃，v6（2024-12 TypeScript 重写） | MIT | 无官方绑定，手写 composable | 低：编辑器导向（对象模型/序列化），装饰层用不上 | 中 |

包体与上手成本（约数）：Konva 核心 ~200KB min（~70KB gzip）量级；PixiJS ~400KB+ min（视特性）；Phaser ~1MB+ min；Fabric ~250KB min。上手成本：Konva < PixiJS < Fabric < Phaser。

### 1.2 结论

**一期维持"原生 Canvas 2D + 单 rAF"（零新依赖，D14 既有结论，不推荐为氛围层引入任何场景图引擎）。**

- 氛围层"无交互、无命中、纯装饰"：场景图引擎的图层/命中/序列化能力全部用不上，属于"为不需要的能力付包体税"。
- 若未来确有"即用"需求（如氛围层要做编辑/交互），**Konva + vue-konva 最接近"Vue Flow 之于节点树"的成熟度**（官方绑定、活跃维护、MIT），可作升级路径；PixiJS 保留为二期特效（WebGL 粒子/光效）演进位，与既有结论一致；Phaser / Fabric.js 不推荐。

### 1.3 来源

- Konva 官方"如何选择 Canvas 库"指南: <https://konvajs.org/zh-Hans/docs/guides/best-canvas-library.html>
- Konva stars（star-history 镜像）: <https://www.star-history.com/konvajs/konva/>
- vue-konva（官方 Vue 3 绑定）: <https://github.com/konvajs/vue-konva>
- PixiJS v8 发布（WebGPU/WebGL）: <https://pixijs.com/blog/pixi-v8-launches>
- PixiJS stars（star-history 镜像）: <https://www.star-history.com:2087/pixijs/pixijs/>
- vue3-pixi（社区渲染器）: <https://github.com/hairyf/vue3-pixi>
- Phaser stars（star-history 镜像）: <https://www.star-history.com:2087/phaserjs/phaser/>
- Phaser 4 下载页: <https://phaser.io/download/phaser4>
- Fabric.js 项目页（stars 聚合）: <https://www.repoportal.com/en/fabricjs-fabricjs>
- Canvas 库横向对比（2026）: <https://www.pkgpulse.com/guides/fabricjs-vs-konva-vs-pixijs-canvas-2d-graphics-2026>

---

## 2. DOM↔Canvas 同步与 DOM 元素间连线

### 2.1 候选对比

| 库 | stars（2026-09 检索） | 维护状态 | 许可证 | Vue 3 集成 | 贴合度 | 源码修改风险点 |
| --- | --- | --- | --- | --- | --- | --- |
| **leader-line**（anseki） | ≈5.5k（估计） | **基本停维**：最后发版 1.0.8（约 2021 年），作者长期无实质更新，issue 积压 | MIT | 无绑定，手写指令封装 | 高（DOM-to-DOM 带箭头连线正是其用途） | 高：停维 + 对 shadow DOM/现代布局兼容差，出问题只能自己改 |
| **jsPlumb（community）** | ≈8.5k（估计） | 仍在发版（`@jsplumb/community` 持续维护） | MIT（社区版） | 无绑定，手写 | 中：面向"可连接端点/流程图编辑器"，自带拖拽命中，对本场景偏重 | 中偏高：商业 Toolkit 存在，社区版是引流品，路线受厂商影响 |

### 2.2 结论

**明确回答：该品类没有 ≥10k 的热门活跃库，"讨论连线"必须自写最薄实现——而且按 D14，连线本就在 Canvas 氛围层，连"DOM 连线库"都不需要。**

最薄实现方案（符合 D14 既有结论，约 100～200 行）：

1. 连线的**绘制**在 Canvas 氛围层完成（`ctx.beginPath/moveTo/lineTo`，可加渐变/发光）；
2. 端点坐标来自**人物 DOM 位置**：优先从状态机坐标直接取（移动由状态机驱动、DOM transform 只是投影），需要真实 DOM 值时缓存 `getBoundingClientRect`，经 `ResizeObserver` 失效；
3. 单一 rAF 循环内"先批量读 → 再统一写 canvas"，避免每条连线每帧强制布局（layout thrashing）。

若未来有人物层 DOM 内画线需求（当前架构下不采用），退路是 SVG `<line>` + 端点事件监听（约 150 行），同样无需依赖库。**leader-line 不采用**（停维 + <10k 且风险高于收益）；**jsPlumb 不采用**（重、面向编辑器、社区版受厂商商业路线影响）。

### 2.3 来源

- leader-line（GitHub）: <https://github.com/anseki/leader-line>
- leader-line README（npm 1.0.8 版）: <https://app.unpkg.com/leader-line@1.0.8/files/README.md>
- jsPlumb（GitHub）: <https://github.com/jsplumb/jsplumb>
- Canvas overlay 与 DOM 内容对齐/端点同步实践: <https://stackoverflow.com/questions/77346607/drawing-into-a-position-fixed-overlay-aligned-with-scrolling-inline-content>

---

## 3. 人物移动与拖拽（离席制移动动画、锚点拖拽、自动移动不覆盖锚点）

### 3.1 候选对比

| 库 | stars（2026-09 检索） | 维护状态 | 许可证 | Vue 3 集成 | 贴合度 | 源码修改风险点 |
| --- | --- | --- | --- | --- | --- | --- |
| **GSAP** | ≈28.1k（star-history 镜像） | 活跃（Webflow 旗下，持续发版） | **Standard License（2024-11 后全部插件免费商用，见 §6）** | 框架无关，composable 封装（`useGsap` 或直接 `gsap.to`） | **最高**：`timeline` 天然表达"离席→聚拢→归锚点"序列；`Draggable`/`MotionPathPlugin` 免费可用 | 低：商业公司闭源，未来条款变更需关注（历史有过收费风波，2024 后明确免费） |
| **anime.js** | ≈72.6k（star-history 镜像） | v4（2024-11 完全重写）后更新趋缓 | MIT | 框架无关 | 高：v4 `create()`/`timeline()` 轻量、可 tree-shake，与状态机配合直接 | 低 |
| **Motion（motion.dev）** | ≈33.4k（star-history 镜像） | 活跃（framer-motion 与 Motion One 合并后主推） | MIT | **官方 Vue 支持**（`v-motion` 指令、`useMotionValue` 等） | 高：`animate()` 声明式 + 状态值响应式，与 Vue 响应式亲和 | 低 |
| **interact.js** | ≈10.5k（估计） | 趋缓：1.10.x，近年发版稀疏 | MIT | 无绑定，手写 | 中：拖拽/缩放/手势 + 惯性/吸附，但**无 timeline**，动画编排要靠外部 | 中 |
| **moveable** | ≈10.8k（star-history 镜像） | 活跃（daybrush 持续发版） | MIT | **官方 vue3-moveable**（仓库内独立包） | 高（拖拽侧）：锚点拖拽 + 对齐参考线 + 边界约束 + 吸附 | 低 |
| **@vueuse/useDraggable** | VueUse 包内（VueUse 整体 star-history 镜像 ≈22.3k，镜像可能滞后） | 活跃 | MIT | **原生 Vue 3 composable** | 中（最薄）：Pointer Events 拖拽 + 可选持久化，无动画/对齐 | 低 |

### 3.2 结论

- **状态机驱动移动（讨论→聚拢、结束→归锚点）用 GSAP `timeline` 最贴合**：一个 timeline 实例承载"离席/聚拢/归位"整段序列，`pause()/resume()/timeScale()` 支持会议打断与快速归位；状态机只产出"目标位置 + 移动意图"，GSAP 只做投影动画，两者解耦（符合 D15 与既有"业务不等待动画"约束）。备选：anime.js v4（更轻、MIT 无商业条款，若团队不想引入商业公司闭源产品）；Motion 官方支持 Vue 且响应式亲和，亦可用。
- **拖拽与自动移动的协调**：锚点拖拽用 moveable + vue3-moveable（对齐线/约束对"工位锚点"场景加分）；最薄方案用 `@vueuse/useDraggable`。**协调规则不变**：自动移动（GSAP）只读目标坐标、永不写锚点（锚点由拖拽独占写入），两者经"状态机唯一权威 + 动画仅投影"解耦——即既有 D15 结论，库只负责各自半场的执行。
- **interact.js 不推荐**：热度达标但无 timeline 且维护趋缓，收益不抵 GSAP/Moveable 组合。

### 3.3 来源

- GSAP（GitHub）: <https://github.com/greensock/GSAP>
- GSAP stars（star-history 镜像）: <https://www.star-history.com:2087/greensock/gsap/>
- Webflow「GSAP 100% 免费」公告: <https://webflow.com/blog/gsap-becomes-free>
- GSAP Standard License: <https://gsap.com/community/standard-license/>
- anime.js（GitHub）: <https://github.com/juliangarnier/anime>
- anime.js stars（star-history 镜像）: <https://www.star-history.com:2096/juliangarnier/anime/>
- Motion（GitHub）: <https://github.com/motiondivision/motion>
- Motion for Vue 官方文档（指令/响应式值）: <https://motion.dev/docs/vue-directive>、<https://motion.dev/docs/vue-motion-value>
- interact.js（GitHub）: <https://github.com/taye/interact.js>
- moveable（GitHub）: <https://github.com/daybrush/moveable>
- vue3-moveable（官方包说明）: <https://github.com/daybrush/moveable/blob/master/packages/vue3-moveable/README.md>
- VueUse（useDraggable 所属仓库）: <https://github.com/vueuse/vueuse>

---

## 4. 角色动画资产（待机/思考/讨论状态化动效，二期可选，非一期必须）

### 4.1 候选对比

| 方案 | stars（2026-09 检索） | 维护状态 | 许可证（陷阱见 §6） | Vue 3 集成 | 贴合度 | 源码修改风险点 |
| --- | --- | --- | --- | --- | --- | --- |
| **lottie-web** | ≈32.1k（star-history 镜像） | 缓慢：airbnb 主导，发版稀疏（v5.13，2025 前后），社区 fork 多 | MIT | vue3-lottie（社区包装）或手写 composable | 高：设计师 AE 导出 JSON，换肤/换动效成本低；与"皮肤=词表+模板"的数据驱动契合 | 中：上游发版慢，新 AE 特性支持滞后，长期依赖社区 fork |
| **Rive（@rive-app/canvas）** | ≈5k（估计，rive-wasm） | 活跃（商业公司持续迭代） | runtime MIT（rive-wasm 仓库）；**编辑器商业**（免费层 + $9/月付费层） | 无官方 Vue，手写 composable（官方运行时） | 高：**状态机驱动**（待机/思考/讨论可在 .riv 内切状态）与"运行状态绑定动画"最契合 | 中：stars 处于 5k 档边缘；动画资产生产依赖 Rive 编辑器（订阅制） |
| **Live2D Cubism Web SDK** | 不适用（专有许可，非开源仓库） | 活跃（商业公司） | **专有许可**：免费版限个人或年收入 <1000 万日元；发布必须显示 Live2D 商标；禁止再分发 SDK | 无官方 Vue，手写（官方 Web SDK） | 中：2D 拟人表现质量最高，但与 CSS pet 是**替换**而非叠加，工程量大 | 高：许可证陷阱最多（门槛/商标/许可费改定，2025 年有发布许可费改定公告） |
| **Spine runtime** | spine-runtimes ≈9k（估计） | 活跃 | runtime 开源（Spine Runtimes License，宽松）；**编辑器付费**（Essential $69 起） | 无官方 Vue，手写（官方 JS runtime） | 中：骨骼动画，表现力强 | 中高：动画资产生产必须购买 Spine 编辑器；工具链商业依赖；对 DOM pet 是替换 |

与现有 CSS pet 方案的关系：**一期不引入任何一项，继续复用 pet（D14 前提）；上述全部为"替换/增强"性质，只进二期。** 若二期选型：**lottie-web 最稳**（热度、MIT、资产生态最大、与皮肤数据驱动契合）；Rive 状态机最契合但 stars 边缘 + 编辑器订阅；Live2D / Spine 因许可证陷阱与美术管线成本明确不推荐。

### 4.2 来源

- lottie-web（GitHub）: <https://github.com/airbnb/lottie-web>
- lottie-web stars（star-history 镜像）: <https://www.star-history.com:2087/airbnb/lottie-web/>
- vue3-lottie（Vue 3 包装）: <https://github.com/megasanjay/vue3-lottie>
- Rive runtime（rive-wasm）: <https://github.com/rive-app/rive-wasm>
- Rive 商业定价（$9/mo 计划）: <https://framer.rive.app/blog/rive-s-new-9-mo-plan>
- Live2D Cubism FREE vs PRO 对比（许可分级）: <https://www.live2d.com/en/cubism/comparison/>
- Live2D CubismWebSamples 许可声明（SDK 许可文本）: <https://github.com/Live2D/CubismWebSamples/blob/develop/LICENSE.md>
- Live2D SDK 使用与发布许可帮助: <https://help.live2d.com/zh-CHS/sdk/>
- Live2D SDK 发布许可费改定公告（2025）: <https://www.live2d.jp/news/changeofreleaselicensefee/>
- Spine Runtimes License Agreement: <http://zh.esotericsoftware.com/spine-runtimes-license>
- Spine runtime 商用讨论（官方论坛）: <https://zh.esotericsoftware.com/forum/d/28670-discussion-on-using-the-spine-runtime-for-commercial-purposes>
- spine-runtimes（GitHub）: <https://github.com/EsotericSoftware/spine-runtimes>

---

## 5. 气泡与信息浮层（审批气泡、思考流、人物详情浮层的定位与箭头）

### 5.1 候选对比

| 库 | stars（2026-09 检索） | 维护状态 | 许可证 | Vue 3 集成 | 贴合度 | 源码修改风险点 |
| --- | --- | --- | --- | --- | --- | --- |
| **floating-ui** | ≈32.7k（star-history 镜像） | 活跃（持续发版） | MIT | **官方 `@floating-ui/vue`** | 高：正是"相对锚点定位 + 箭头"的通用原语；tree-shake 后体积小（~3-6KB gzip 量级） | 低 |
| **tippy.js** | ≈12.3k（star-history 镜像） | **维护模式**：v6 稳定，作者重心已转向 floating-ui | MIT | 社区包装（非官方） | 中：完整工具提示组件，但我们是自绘气泡（pet 样式），只需要定位原语 | 中：停更风险 |
| **floating-vue** | ≈2.9k（估计） | 中等（Akryum 个人维护） | MIT | 原生 Vue 3 组件库 | 高（Vue 生态内最顺） | **<5k，按硬门槛不推荐** |

### 5.2 结论

**现状 pet 组件已含气泡/思考流/审批气泡的样式与结构，缺的只是"相对人物锚点的定位 + 箭头"这一小块能力 → 引入官方 `@floating-ui/vue` 作为定位基础（直接采用，一期可选），样式层继续复用 pet。**

- 引入价值明确且克制：只取 `useFloating` + `arrow`（middleware），不自造定位算法；不引入 tippy（维护模式、多余组件层）、不引入 floating-vue（<5k，且 `@floating-ui/vue` 已覆盖其定位能力）。
- 若一期想零新依赖，也可维持现状（气泡跟随人物 DOM 内定位），把 floating-ui 列为 C16 实现时的可选增强；但审批气泡/详情浮层挂在"人物"上且人物会移动，官方绑定成本极低，建议直接采用。

### 5.3 来源

- floating-ui Vue 官方文档（`@floating-ui/vue`）: <https://floating-ui.com/docs/vue>
- floating-ui stars（star-history 镜像）: <https://www.star-history.com:2087/floating-ui/floating-ui/>
- tippy.js（GitHub）: <https://github.com/atomiks/tippyjs>
- tippy.js stars（star-history 镜像）: <https://www.star-history.com/atomiks/tippyjs/>
- floating-vue（GitHub）: <https://github.com/Akryum/floating-vue>

---

## 6. 桌面平移缩放与多任务重排（大桌面缩放、区域尺寸自适应）

### 6.1 候选对比

| 方案 | stars（2026-09 检索） | 维护状态 | 许可证 | Vue 3 集成 | 贴合度 | 源码修改风险点 |
| --- | --- | --- | --- | --- | --- | --- |
| **panzoom**（timmywil） | ≈7k（估计） | 稳定但发版稀疏（v5.x；releases 页有维护记录） | MIT | 手写 composable | 高：单容器 pan/zoom、wheel/捏合、变换矩阵 | 低 |
| **d3-zoom** | 独立仓库 ≈1.7k（估计）；所属 **d3 伞项目 110k+** | 活跃（d3 v7 维护） | ISC | 手写（d3 生态） | 中：`zoom()` behavior 成熟，但需自行把变换接回 DOM transform / canvas，API 较重 | 低 |
| **CSS transform + @vueuse** | VueUse 包内 | 活跃 | MIT | 原生 | 高：统一 zoom 因子，DOM 与 Canvas **同乘同一因子**（与 D14 完全同构） | 低：完全自控 |

### 6.2 结论

**一期采用"CSS transform 统一 zoom 因子 + @vueuse 手势 composable"（零新依赖，最贴合 D14 的"统一 zoom 因子"既有结论）；panzoom（≈7k、MIT、轻量）作为需要成熟 wheel/捏合处理时的即用备选；d3-zoom 不推荐**（能力过剩：需把 d3 变换再适配到 DOM/canvas，等于多一层桥接，仅未来需要复杂缩放过渡/比例尺时再考虑）。

重排逻辑（区域尺寸变化后人物按区域相对坐标重排，C16 步骤 2）无现成组件，属场景模板数据驱动布局的一部分，自写。

### 6.3 来源

- panzoom（GitHub）: <https://github.com/timmywil/panzoom>
- panzoom releases: <https://github.com/timmywil/panzoom/releases>
- d3-zoom（GitHub）: <https://github.com/d3/d3-zoom>
- VueUse（手势/拖拽 composable 所属仓库）: <https://github.com/vueuse/vueuse>

---

## 汇总表：绘制元素 → 推荐方案

| 绘制元素 | 推荐方案 | stars（2026-09 检索） | 许可证 | 一期/二期 |
| --- | --- | --- | --- | --- |
| 氛围层（连线/粒子/涟漪/光效） | 原生 Canvas 2D + 单 rAF（D14 维持）；Konva 为即用升级备选，PixiJS 二期特效演进位 | Konva ≈14.7k / PixiJS ≈48.1k | MIT | 一期（自写） |
| 讨论连线（DOM 人物 ↔ Canvas 端点） | **自写最薄实现**：rAF 端点同步（状态/rect → canvas 绘制）；leader-line 停维不采用 | 品类无 ≥10k 活跃库 | — | 一期（自写） |
| 人物移动（离席制状态机动画） | **GSAP timeline**（首选）；anime.js v4 / Motion 备选 | GSAP ≈28.1k / anime ≈72.6k / Motion ≈33.4k | GSAP 标准许可（免费）/ MIT | 一期 |
| 锚点拖拽 | **moveable + vue3-moveable**；最薄 `@vueuse/useDraggable` | moveable ≈10.8k | MIT | 一期 |
| 角色动效（待机/思考/讨论） | 一期复用 CSS pet；二期 **lottie-web 首选**，Rive（状态机契合）备选 | lottie-web ≈32.1k / Rive ≈5k | MIT / runtime MIT+编辑器商业 | 二期 |
| 气泡浮层（审批/思考流/详情 + 箭头） | **`@floating-ui/vue`**（定位+箭头），样式复用 pet | floating-ui ≈32.7k | MIT | 一期（可选） |
| 平移缩放 | **CSS transform 统一 zoom 因子 + @vueuse**（一期自写）；panzoom 备选 | panzoom ≈7k | MIT | 一期 |

---

## 推荐组合（相互兼容性 + 体积/维护权衡）

**一期建议新增依赖（按必要性排序）：**

1. **GSAP**（核心 + `timeline`）——人物移动动画。与 Vue 3 无冲突（框架无关），是唯一需要认真评估商业条款的依赖（见 §6 许可，结论是可用）。
2. **`@floating-ui/vue`** —— 浮层定位 + 箭头。官方维护、MIT、tree-shake 后 ~3-6KB gzip，与 DOM 人物层天然配合。
3. **moveable（+ vue3-moveable）**（可选）—— 锚点拖拽增强（对齐线/约束）。若一期只想最薄，用 `@vueuse/useDraggable` 替代，二者不冲突。

其余全部自写 composable：氛围层渲染循环、连线端点同步、zoom 因子、状态机→GSAP timeline 的编排、场景模板布局落位。自写总量估计：5 个 composable，合计约 600～1000 行，均在既有 C15/C16 职责内。

**体积与维护权衡（诚实声明）：** 一期不引入 Konva/PixiJS/Phaser/Fabric（合计可省约 400KB+ min 与一整层引擎复杂度）；GSAP + floating-ui + moveable 新增 gzip 约 40～60KB 量级（GSAP 核心 ~23KB gzip、floating-ui ~3-6KB、moveable ~20KB+），换取的是"离席制移动序列、浮层定位、锚点拖拽"三项即用能力，性价比高于任何单一场景图引擎。维护面：三个库均为活跃/官方维护，许可证干净（GSAP 例外，见下）。

**仍需自写的部分（不夸大覆盖面）：**

1. 氛围层渲染循环（rAF、粒子/涟漪/光效算法、DPR、`visibilitychange` 释放清单）——业界没有"装饰性氛围层"现成库；
2. DOM↔Canvas 端点同步与连线绘制（rAF 批量读 → canvas 写，防 layout thrashing）；
3. 状态机 ↔ 动画编排层：讨论/聚拢/归锚点状态到 GSAP timeline 的映射，含"自动移动永不覆盖锚点"约束的读/写分离；
4. 场景模板（词表 + 区域布局）→ 人物落位/重排算法（C16 步骤 2）；
5. 平移缩放的重排逻辑（zoom 因子 → DOM transform + canvas 同乘 + 区域自适应）。

---

## 许可证与风险（重点标注有陷阱的候选）

| 候选 | 许可证现状 | 陷阱/风险要点 | 处置建议 |
| --- | --- | --- | --- |
| **GSAP** | 2024-11 Webflow 收购后全部插件（含 Draggable、MotionPathPlugin、SplitText、ScrollTrigger 等）100% 免费商用；现行条款为 GSAP Standard License（LicenseDB 收录 no-charge 2025 版） | ① 商业公司闭源产品，条款可单方变更（历史上有过收费/条款风波，2024 后明确免费）；② 免费覆盖需以官方 Standard License 页面为准，勿用旧版按收入付费条款理解 | **可用**；采购时锁版本，实施前复核官方许可页 |
| **Live2D Cubism SDK** | **专有许可**（非开源） | ① 免费仅限个人或年收入 <1000 万日元（约 $70k）的企业；超出必须购买发布许可并签出版许可契约；② 发布的应用**必须显示 Live2D 商标与链接**；③ 禁止再分发 SDK；④ 2025 年发布许可费改定，费用结构有变 | **不推荐**（一期/二期均不进入）；若未来要 2D 拟人，先走法务评审 |
| **Spine** | runtime 开源（Spine Runtimes License，宽松）；**编辑器付费**（Essential $69 起） | ① runtime 可免费用，但动画资产生产必须购买编辑器，美术管线成本高；② 工具链强依赖 Esoteric 商业产品 | **不推荐** |
| **Rive** | runtime MIT（rive-wasm 仓库）；**编辑器商业**（免费层 + $9/月） | ① stars 处于 5k 档边缘（硬门槛边界，若采用需明确其"状态机品类事实标准"地位并接受风险）；② .riv 资产由 Rive 工具生产，团队需订阅 | **二期备选**；采用前复核仓库 LICENSE 与定价 |
| **leader-line** | MIT | 停维（2021 年后无实质发版），现代布局/shadow DOM 兼容存疑 | **不采用**（自写替代） |
| **jsPlumb** | 社区版 MIT | 社区版是商业 Toolkit 引流品，路线受厂商影响；功能对本场景过重 | 不采用 |
| 其余全部（Konva/PixiJS/Phaser/Fabric.js/anime.js/Motion/interact.js/moveable/floating-ui/tippy.js/panzoom/d3-zoom/lottie-web/VueUse） | MIT / ISC，无商业条款 | 无明显陷阱 | 按 §1～§6 结论选用 |

---

## 调研局限说明

- stars 数据为 2026-09 检索所得：标注"star-history 镜像"者为 star-history 第三方镜像页展示值；标注"估计"者为按 2025 年公开数据与趋势给出的约数，**实施前应在 GitHub 仓库页复核精确值**（部分仓库镜像数据可能滞后，如 VueUse 镜像值 ≈22.3k 明显低于其实际量级）。
- 许可证以官方页面为准：GSAP（gsap.com/community/standard-license/）、Live2D（live2d.com/cubism/comparison + CubismWebSamples/LICENSE.md）、Spine（esotericsoftware.com/spine-runtimes-license）为权威来源，签约/集成前需再次核对现行版本。
- 包体数字为量级估计（min/gzip 随版本波动），正式技术方案（C15/C16 实施前）应做一次实际 bundle 测量。
