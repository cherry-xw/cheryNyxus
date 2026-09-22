# CheryClaw 前端 UI 技术与设计语言规范

> **状态：强制执行。** 本文是 `web/` 所有用户可见 UI、排版、控件、窗口、内容渲染、动效和界面分面设计的唯一入口。
>
> 适用范围：`web/src/**` 的浏览器界面、Electron 窗口外壳、Pixi 画布、桌宠、Agent 工作台、Lite 视图、登录和设置中心。
>
> 本文同时回答两件事：前端 UI 现在如何实现，以及后续 UI 应遵守什么设计思想。代码级事实以文中链接的源文件和测试为准；本文不替代[前端架构规范](./web-frontend-architecture.md)和[Vue 视图规范](./vue3-page-building-standard.md)。

## 1. 如何阅读本文

本文中的内容分为四类：

| 标记 | 含义 | 修改时的处理 |
| --- | --- | --- |
| **现行规则** | 后续新增或修改 UI 必须遵守的约束 | 直接执行；如需例外先说明理由和范围 |
| **实现事实** | 当前代码已经采用的入口、数值或流程 | 代码改变时同步更新；不能把它误当成新设计建议 |
| **独立分面** | 只属于某个界面或渲染后端的语言 | 不把颜色、圆角、装饰或组件复制到其他分面 |
| **治理事项** | 已发现但暂不在本次改动中处理的旧实现 | 保留边界和删除条件，不继续扩大使用范围 |

文档的权威层级是：

1. 共享协议和状态契约决定 UI 能表达哪些状态；
2. `docs/standards/` 中最小适用范围的强制规则决定实现方式；
3. 当前代码和测试决定已经存在的实现事实；
4. 本文说明视觉意图、跨模块规则和设计取舍；
5. 归档、计划、旧注释和历史文档不能覆盖现行规则。

## 2. 产品 UI 的设计思想

### 2.1 统一基础，不统一外观

CheryClaw 不是把所有页面做成同一套卡片皮肤。它使用一套共享的主题、文字、状态、层级和动效基础，再让不同界面根据任务表达不同气质：

- 工作台帮助用户观察 Agent 的执行过程；
- Lite 帮助用户快速读懂任务状态和时间轨迹；
- 桌宠把复杂状态压缩成陪伴角色、气泡和舞台；
- 桌面外壳帮助用户管理多个独立窗口；
- 登录把连接和安全动作变成可理解的反馈；
- 设置帮助用户在复杂配置中定位、编辑、保存和恢复。

**现行规则：**共享的是语义和行为，不是每个界面的装饰。全局 token、状态反馈、键盘行为、层级协议和性能边界必须一致；CRT、霓虹、纸牌、emoji 风和暗房手电光只在声明的分面内使用。

### 2.2 信息先于装饰，状态先于动画

视觉层级按以下顺序建立：

1. 用户当前要完成的动作；
2. 当前状态、风险、阻塞原因和下一步；
3. 用户正在阅读或操作的主要内容；
4. 辅助说明、来源、时间和诊断信息；
5. 环境装饰、辉光、纹理和循环动效。

装饰不能遮挡正文、抢走操作焦点或制造虚假的运行状态。动画首先表达状态变化、空间关系和操作结果，其次才承担气氛。没有信息变化就不新增持续运动。

### 2.3 先确定状态 owner，再决定视觉表达

UI 不应从原始协议数据或多个 store 中自行拼出业务含义。推荐的转换链是：

```text
transport / IPC / HTTP / WebSocket
        ↓
service adapter（只负责输入输出）
        ↓
store 或 application public port（唯一状态 owner）
        ↓
domain / feature model / projection（纯展示模型）
        ↓
controller / composable（Vue 生命周期和用例连接）
        ↓
view / component（模板、样式、可访问性和事件）
        ↓
CSS / GSAP / Pixi / Worker 等渲染后端
```

例如：

- 消息先经过聊天 projection，再由 `MessageBubble` 判断 Markdown、thinking、工具调用、媒体和风险标记；
- Lite 由 `useLiteViewController()` 提供轨迹、节点、详情抽屉、输入和交互模型；
- 设置由父级 draft owner 保存草稿，当前 tab 只是该草稿的编辑视图；
- 桌面窗口由 workspace window state 提供几何、聚焦、最小化、关闭和 attention；
- Nyxus 执行图由 graph projection 生成 Pixi 场景，原始运行数据不直接携带颜色和布局。

跨层边界见[`web-frontend-architecture.md`](./web-frontend-architecture.md#3-依赖矩阵)和[`vue3-page-building-standard.md`](./vue3-page-building-standard.md#2-三种角色)。视觉代码也必须遵守这些边界：模板不直连 service，通用组件不拥有 Agent 或 Pet 状态，纯计算尽量离开 Vue 生命周期。

### 2.4 核心交互必须在低装饰和低性能档仍然成立

功能反馈不能依赖扫描线、辉光、弹性、颜色变化或连续帧。以下信息至少要有文字、几何、位置、图标、ARIA 或可操作状态中的一种稳定表达：

- 正在运行、已完成、失败、等待用户、被阻塞；
- 当前选中项、当前窗口、当前链路和当前 tab；
- 按钮为什么不能用；
- 连接是否成功、当前连接到哪里；
- 内容是否仍在流式更新、是否已经截断；
- 是否存在未保存修改或外部配置变化。

## 3. 前端运行面与 UI 组装方案

### 3.1 启动顺序

[`web/src/main.ts`](../../../web/src/main.ts#L1-L83) 是浏览器和 Electron renderer 共用的初始化入口：

1. 先加载 Element Plus 样式、深色 css variables 和项目主题 token；
2. 创建 Vue 应用与 Pinia；
3. 初始化 GSAP 核心和 Mermaid 自动渲染；
4. 只显式注册实际使用的 Element Plus 组件，避免完整组件库进入首屏；
5. 配置 service auth；
6. 在首次挂载前应用持久化主题，避免浅色闪烁；
7. 挂载 `App.vue`。

新增全局 UI 基础设施时，应先判断它属于启动初始化、全局样式、application runtime 还是 feature。不要把启动副作用塞进单个窗口组件，也不要在多个 feature 各自初始化同一套 transport、主题或持续帧任务。

### 3.2 Surface 是界面组装边界

[`web/src/App.vue`](../../../web/src/App.vue#L35-L81) 根据 URL 参数和宿主环境分发运行面。当前主要 surface 包括：

| Surface | 作用 | 典型内容 |
| --- | --- | --- |
| 浏览器完整面 | 单页工作区 | 桌宠、Agent、桌面外壳、多个浏览器工作窗 |
| `desktop` | Electron 透明桌宠面 | 桌宠和无遮罩浮动交互 |
| `settings` | Electron 原生设置窗 | `WindowFrame` + 设置中心 |
| `workbench` | 每个预设一个原生工作窗 | `WindowFrame` + 工作台三视图 |
| `composer` | 独立发送窗 | `WindowFrame` + Agent Composer |
| Terminal | 独立终端面 | `WindowFrame` + xterm |

重型面通过 `defineAsyncComponent()` 按实际状态加载。设置、历史、会话、Pixi 工作台、终端和桌面壳不应在冷启动时全部解析。关闭 surface 时必须让组件、Worker、Pixi、GSAP context、帧订阅和事件监听完整释放。

### 3.3 依赖方向和 UI 文件职责

UI 代码使用以下边界：

```text
features -> application public ports -> stores -> services -> transport
      \--------------> domain <--------------/
application runtime = 负责组装依赖的唯一例外
```

- **View / Component**：模板、样式、可访问性、props/emits 和一个语义完整的 controller；不直连 store/service。
- **Controller / composable**：refs、computed、watch、生命周期、用例触发和错误呈现；不把确定性计算长期留在其中。
- **Presenter / model**：不依赖 Vue、DOM、store、service；把领域数据变成展示模型或状态迁移结果。
- **Store / application port**：拥有跨组件的 canonical state；其他 UI 只调用公开 action/selector。
- **Shared component**：不知道 Agent、Chat、Pet 等业务 owner；只接受普通 props/slots 并发出事件。
- **Styles**：全局 token 和跨应用层级放 `src/styles/`；组件专属样式与唯一消费者同址。

## 4. 全局视觉基础层

### 4.1 主题基础

[`web/src/styles/theme.css`](../../../web/src/styles/theme.css#L20-L170) 是全局 token 的唯一来源。浅色是冷白和靛蓝，深色是深空蓝紫和电光青：

| 类别 | 主要 token | 设计作用 |
| --- | --- | --- |
| 文字 | `--ink` | 当前主题下的主要可读文字 |
| 交互强调 | `--accent`、`--accent-ink` | 聚焦、选中、主动作及其反色文字 |
| 表面 | `--bg`、`--panel`、`--surface`、`--surface-hover` | 页面、面板、卡片和悬停层级 |
| 边界 | `--border`、`--border-strong`、`--scrim` | 分隔、遮罩和层级边缘 |
| 语义 | `--success`、`--danger`、`--warning`、`--info` | 成功、危险、警告和辅助状态 |
| 文字 | `--font-ui`、`--font-mono` | 普通 UI 与代码/标识/时间信息 |
| 动效 | `--dur-*`、`--ease-*` | CSS 与 GSAP 的基础语义时长和曲线 |

当前全局主题值如下。新增实现使用语义名，不在组件中复制这些十六进制值：

| token | 浅色 | 深色 |
| --- | --- | --- |
| `--ink` | `#1b2337` | `#e8ecf8` |
| `--accent` | `#4f46e5` | `#22d3ee` |
| `--accent-ink` | `#f5f3ff` | `#04202b` |
| `--bg` | `#f5f7fc` | `#0b1020` |
| `--panel` | `#fbfcff` | `#10162e` |
| `--surface` | `#ffffff` | `#161d38` |
| `--surface-hover` | `#f8fafd` | `#1b2444` |
| `--success` | `#15803d` | `#4ade80` |
| `--danger` | `#b91c1c` | `#f87171` |
| `--warning` | `#a16207` | `#fbbf24` |
| `--info` | `#64748b` | `#94a3b8` |

边框、遮罩和派生色使用 `--border`、`--border-strong`、`--scrim`、`--accent-soft` 和 `--accent-glow`。文字透明度优先使用 `color-mix(in srgb, var(--ink) X%, transparent)`，不为每个透明度继续增加 token。代码高亮使用冷色 Tokyo-night 方向：关键词紫、字符串绿、数字橙、标题青、注释灰蓝。

新增 UI 先查语义 token。禁止为了局部方便另起全局颜色或字号变量，也禁止把一个界面的独立调色板写进全局 token。

### 4.2 字体、字号、字重、几何

- 普通 UI 使用 `--font-ui`；代码、终端、时间、标识等辅助信息使用 `--font-mono`。
- 普通内容、按钮、label、状态、计数、tooltip、popover 和 Markdown 非标题默认 `font-weight: 400`。
- 真实页面、窗口、章节或卡片标题可以使用 `600`，不超过 `600`；不能因为标签叫 title 或使用了 `strong` 就自动加粗。
- 中文阅读内容不小于 `12px`；正文和表单建议 `13–14px`、行高 `1.5–1.6`。工作台树、对话、Lite 及其弹窗和输入内容执行 +2px 可读性基线。
- 全局新增按钮、卡片、面板、弹窗和输入框默认直角 `border-radius: 0`。
- `--radius-control` 和 `--radius-panel` 是历史 token，不因存在就代表新实现可以使用圆角。桌宠气泡、历史消息等独立存量例外不能外扩。
- 新布局优先用位置、留白、边界和颜色表达层级，不用连续加粗和大面积阴影制造层级。

### 4.3 颜色、对比度和状态

高亮、hover、active、选中、主按钮和辉光使用 `--accent`、Element Plus primary 或 `color-mix` 派生。`--accent-ink` 只用于实心 accent 背景上的反色文字，不是普通强调文字色。

正文对比度至少 `4.5:1`，必要控件和连线至少 `3:1`，按最终混合背景计算。状态不能只靠颜色表达，至少同时有文字、图形、位置、边界、图标或 ARIA 状态中的一种。

Element Plus 的实际使用方式是：[`web/src/main.ts`](../../../web/src/main.ts#L44-L68) 显式注册组件；[`web/src/styles/element/index.scss`](../../../web/src/styles/element/index.scss) 覆盖浅色变量；`theme.css` 的 `html.dark` 覆盖深色 css-vars。不要在组件内重新定义一套 primary。

### 4.4 全局样式入口

- `theme.css`：token、主题、代码高亮、字体、根背景和全局浏览器样式。
- `markdown.less`：Markdown 内容排版。
- `scrollbar.less`：`.inner-scrollbar()` 内层滚动条原语。
- `windowControls.less`：窗口三键。
- `overlayLayers.ts`：窗口和 overlay 层级常量。
- `dialog.less` 当前没有被引用，是死代码；其中的圆角和 `backdrop-filter` 不属于现行规范。

## 5. 主题与多个渲染后端

主题不是单纯换 CSS 颜色，而是一个跨窗口、跨渲染后端的状态协议。

[`web/src/stores/theme.ts`](../../../web/src/stores/theme.ts#L18-L91) 的不变量：

1. `toggle()` 负责持久化、应用并广播；
2. `applyFrom()` 只应用外部主题，不再次广播，避免回环；
3. 首次挂载前必须应用主题；
4. 浏览器窗口通过 `storage`/`BroadcastChannel` 同步；Electron 窗口还可以通过桌面桥接同步；
5. CSS 使用 `data-theme`，Element Plus 使用 `html.dark`；
6. Pixi 使用 `useThemeTokens.ts` 的 `PIXI_CANVAS_PALETTES`，不能直接读取 CSS 变量；
7. Mermaid 监听 `data-theme` 变化后重绘已有图表；
8. Electron 原生窗锁定根 `color-scheme` 并使用 `window-surface` 背景，避免系统灰边。

任何新渲染后端都必须回答：主题从哪里读取、主题切换时如何更新、卸载时如何取消监听、深浅色是否都能读清。组件不能自行保存第二份主题状态。

## 6. 窗口、overlay 与层级方案

### 6.1 两类窗口外壳

- `CyberWindow` 是浏览器工作区中的可移动、可缩放、可聚焦、可最小化窗口；几何和 z-order 来自 workspace state。
- `WindowFrame` 是 Electron 原生独立窗通用外壳；标题栏、三键、拖动、最大化状态和根背景由它统一处理。

两者共享深空电光窗口语法，但不应互相复制生命周期逻辑。原生面不重复渲染内部标题栏；浏览器面不假设存在 Electron IPC。

窗口标题栏的核心约束：

- 标题栏可拖动，按钮和标题动作区必须 `no-drag`；
- 标题、channel 徽记和 signal 在窄宽度下按顺序隐藏装饰，不能挤出三键；
- 窗口最小尺寸为 `360×260`；
- 标题、关闭、最大化、最小化必须有可读的 ARIA 名称；
- attention 表达待处理事项，但不能阻塞用户继续操作；
- 拖动和缩放只在指针生命周期内写入 transform/geometry，结束时提交最终几何状态。

### 6.2 层级协议

[`web/src/styles/overlayLayers.ts`](../../../web/src/styles/overlayLayers.ts#L1-L53) 中的 `OVERLAY_Z_INDEX`、`WORKSPACE_WINDOW_Z_INDEX_BASE` 和 `NYXUS_WORKBENCH_Z_INDEX` 是唯一层级 owner：

- 浏览器工作区窗口从 `500` 起，按 `2` 递增；
- 全局 composer `300`，会话菜单 `9900`，历史抽屉 `10000`，modal `10100`，approval `10200`，tooltip `10300`；
- Nyxus 工作台内部使用独立层级：canvas、node overlay、composer、blocking interaction、chrome、drawer、side popover、connection mask；
- Teleport 到 body 的菜单必须通过 `ownerOverlayZIndex()` 跟随所属窗口；
- 局部 stacking context 不得与应用级 overlay 竞争随机 z-index。

层级解决的是“谁可以盖住谁”，不是业务权限。真正阻塞交互的连接断开、审批和确认面必须同时有清楚文案和可操作出口。

Nyxus 工作台当前内部值是：`canvas 0`、`nodeHitTarget 10`、`runCrt 30`、`nodeOverlay 35`、`composer 40`、`blockingInteraction 50`、`chrome 60`、`drawerMask 70`、`drawer 75`、`sidePopover 80`、`connectionMask 90`。工作台抽屉从标题栏下方开始，不能覆盖原生窗口三键。

### 6.3 遮罩与穿透

Agent Composer 根据来源选择遮罩：历史模态使用遮罩，桌宠和 Nyxus 的快速发送窗保持无遮罩并可拖动。Electron 透明桌宠面中，全屏 overlay 不能拦截桌面穿透命中测试，只有实际 panel 恢复 pointer events。

持续动画场景不使用 `backdrop-filter`。遮罩应使用 `--scrim`，并在 reduced 模式下仍保持明确的前后关系。

## 7. 技术栈职责边界

| 技术 | 负责什么 | 不负责什么 |
| --- | --- | --- |
| Vue 3 | 组件生命周期、模板、响应式 binding、事件和组合 | 不替代领域模型和 transport |
| Pinia | canonical UI/业务状态 owner 和 action | 不让多个组件各自写同一事实 |
| Element Plus | 成熟表单、弹层、选择、提示和基础控件 | 不决定各界面完整视觉身份 |
| CSS/Less/SCSS | token、布局、静态状态、轻量过渡和局部装饰 | 不承载复杂业务状态机 |
| GSAP | DOM 面板、窗口、可中断过渡、高频 transform 写入 | 不逐帧驱动 Vue 响应式 patch |
| Pixi.js | Nyxus 执行图、粒子、边、节点和 Canvas 标签 | 不直接读取 CSS 变量或拥有业务事实 |
| Worker | 流式 Markdown 解析等可异步丢弃的重计算 | 不回写过时 revision |
| ECharts | 统计图表、缩放和密集数据可视范围 | 不用 div 或渐变模拟成熟图表交互 |
| xterm | Terminal 内容和交互 | 不由普通文本组件替代 |
| Mermaid | 受控 Markdown 图表的懒加载和 SVG 绘制 | 不绕过 `html:false` 和 strict security |
| Morphicons | 状态图标的有限形变 | 不制造持续装饰动画 |

新增库或替代实现必须说明适用边界、依赖成本、首屏影响、无障碍能力和低质量/低动效降级。能由现有组件解决的问题不重复引入库。

## 8. 动效、偏好、性能和降级

### 8.1 动效决策顺序

为一个交互加动效前按顺序判断：

1. 是否有空间变化、状态变化或操作反馈需要表达？没有则不加；
2. 是否应该由 CSS 静态过渡完成？是则不用 JS；
3. 是否需要可中断、反向、跨多个元素或高频写入？是则使用 GSAP；
4. 是否属于 Canvas 场景？使用 Pixi 自己的 ticker/场景同步；
5. 是否属于长期装饰？必须接入动效偏好和渲染质量，并有关闭路径。

### 8.2 GSAP 与过渡回收

[`web/src/utils/gsapCore.ts`](../../../web/src/utils/gsapCore.ts) 只初始化一次 `autoSleep: 120`、`force3D: 'auto'` 和 `nullTargetWarn: true`，禁止设置全局 `gsap.defaults()`。

语义时长：`feedback .08s`、`micro .12s`、`control .16s`、`panel .22s`、`view .28s`、`sweep .42s`。普通组件使用 `useGsap()` 建立 scoped context；overlay 使用 `useOverlayTransitionHooks()` 接入 Vue `Transition`。

每个 tween、context、Transition `done()`、帧订阅和事件监听都必须在取消、反向切换、隐藏和卸载时回收。`done()` 只能调用一次。高频写入使用 `quickTo`/`quickSetter`，不能每帧创建 tween 或更新 Vue 响应式状态。

### 8.3 两个独立的降级轴

`useMotionPreference.ts` 的 `system/full/reduced` 表示用户是否允许运动：

- `system` 跟随系统 `prefers-reduced-motion`；
- `full` 保留完整位移、缩放、stagger 和受控装饰；
- `reduced` 保留即时状态反馈和短透明度过渡，取消非必要位移、弹性、stagger 和循环装饰。

`renderQuality.ts` 的 `high/balanced/low` 表示当前设备能承受多少装饰复杂度：

| 档位 | 粒子 | 粒子 DPR | 图 motion | 图效果节点 |
| --- | ---: | ---: | ---: | ---: |
| high | 420 | 2 | 30fps | 48 |
| balanced | 300 | 1.5 | 24fps | 28 |
| low | 180 | 1 | 18fps | 12 |

粒子层另有目标帧率：high 为 idle/active `45/45fps`、atmosphere `20fps`；balanced 为 `30/45/15fps`；low 为 `20/24/10fps`。质量 governor 的降级窗口约为 balanced `2s`、high `3s`，升级需要持续 `10–12s` 的较好 p95，避免在临界性能下频繁来回切档。正常场景目标 p95 帧间隔不超过 `20ms`，压力场景不超过 `33ms`。

质量 governor 根据真实显示帧间隔和 p95 迟滞升降级；它只能减少粒子、DPR、标签分辨率、边脉冲段数、噪点和 effect node，不能人为降低按钮、拖动、输入和状态切换的即时反馈帧率。

### 8.4 持续帧和性能规则

持续物理更新经 `frameCoordinator.ts` 统一接入 GSAP ticker：首个订阅者接入，最后一个退出后移除，页面隐藏时暂停。桌宠舞台边界由 `ResizeObserver` 缓存，tick 内禁止 `getBoundingClientRect()`。

性能验证先执行 `__CHERY_PERF__.reset()`，完成一个连续交互后读取 `__CHERY_PERF__.snapshot()`。至少查看 `sampleCount`、`p95Ms` 和 `maxMs`，不能用最近一帧或主观观感代替连续样本。

## 9. 内容、媒体和图表渲染

### 9.1 流式 Markdown

[`useRenderedMarkdown()`](../../../web/src/composables/useRenderedMarkdown.ts#L4-L89) 的用户体验承诺是“先有反馈，再稳定更新”：

- 首个非空结果立即渲染；
- 后续 delta 默认按 `240ms trailing` 合并；
- 终态或流结束时调用 `flush()`；
- Worker 返回结果必须带 revision，旧结果不能覆盖新结果；
- `preview` 默认限制 `12000` 字符，适用于桌宠气泡、流式小卡和次要预览；
- 主要阅读面使用 `full`；
- delta watch 中禁止同步调用重型 `renderMarkdown()`。

用户消息保持纯文本或分段 token；Agent 输出才进入 Markdown。Markdown 的 `html` 关闭，Mermaid 使用懒加载 SVG、`html:false` 和 strict security；失败时保留可见的转义原文或错误状态。

### 9.2 媒体、代码和大数据

- 图片、视频、音频使用现有 media renderer 和预览组件，不在消息模板里重复实现 URL 或加载状态。
- 代码块使用 `--font-mono` 和双主题 highlight.js 覆盖；浅深色都要保持可读。
- 统计图表使用 ECharts；密集数据用 `dataZoom`、聚合、分段查询或按需采样，不把全部原始记录装入浏览器。
- 大列表使用现有虚拟滚动能力，key 必须稳定。
- 重型面通过异步组件或明确分包边界加载，不能无证据地把所有优化手段加到首屏。

## 10. 响应式、输入和可访问性

### 10.1 响应式原则

本项目的响应式不是把所有内容缩小，而是按优先级退让：

1. 保留主要内容、输入、关闭、提交、暂停和恢复操作；
2. 让标题、链路标签和说明文本截断或横向滚动；
3. 隐藏 signal、channel、扫描纹理等装饰性元素；
4. 调整面板间距和输入高度；
5. 最后才减少非必要动画和装饰复杂度。

现有实现使用 container query 处理窗口标题栏、`ResizeObserver` 处理 Lite 输入宽度和桌宠舞台边界、横向滚动处理多 Agent 链路。不要用固定 viewport 假设替代组件真实可用空间。

### 10.2 表单和前置条件

需要前置字段的动作在渲染期直接 `disabled`，并用 `el-tooltip` 包住可触发提示的外层 `span`，说明第一个缺失条件；提交时仍保留校验作为兜底。

登录面地址为空时禁用提交，远端地址还必须有用户名和密码；本地 loopback 不显示不需要的鉴权字段。设置保存、关闭和外部变更必须明确区分保存中、保存成功、警告、失败和未保存状态。

### 10.3 键盘、名称和状态

- 交互元素必须能键盘操作并有可读名称；
- 表单控件绑定 label 或等价的 ARIA 名称；
- 窗口三键、缩放、链路、轨迹块、灯开关和关闭动作必须有可读名称；
- 设置 tab 使用 `role=tablist/tab/tabpanel`、`aria-selected`、`aria-controls` 和 roving tabindex；方向键、Home、End 可移动焦点；
- `aria-hidden` 只用于不承担信息的装饰图形；
- tooltip 不能是唯一信息来源，关键错误、阻塞和状态必须在页面结构中可读。

## 11. 六个界面分面的技术与设计边界

### 11.1 Agent 运行时工作台：Nyxus CRT

**任务：**把复杂执行过程变成可以观察、定位和操作的执行空间。

入口包括 `WorkbenchDialog.scoped.less`、`agentDialog.less`、`nyxusPopoverTheme.less`、`nodeSkins.ts`、`edgeStyles.ts`、`ExecutionGraphPixiRenderer.ts`。

- `--nx-*` 只服务 CRT 弹窗、执行图详情、审批和提问面；
- 节点和边通过 `NODE_SKINS`、`EXECUTION_EDGE_STYLES` 映射，不把颜色写进图数据；
- Pixi 只接收 projection 后的场景，主题切换通过 palette 重画；
- CRT 扫描线、噪点、偏移文字和边脉冲是辅助层，reduced 或 low 时关闭/削减；
- Composer、抽屉、节点详情和 blocking interaction 必须服从 Nyxus 内部层级；
- 用户内容仍遵守全局字号和 400 字重，不因为 CRT 身份而降低可读性。

当前节点语义包括 `start`、`message`、`user`、`root-agent`、`child-agent`、`tool-batch`、`fold`、`return`、`dispatch`、`spawn`、`system`、`pack`、`epoch`、`input` 和 `unknown`；边语义包括 `start`、`spawn`、`dispatch`、`return` 和 `fork-detail`。新增执行节点先扩展 `nodeSkins.ts`/`edgeStyles.ts` 的语义表，再扩展视图，不能在模板内按字符串临时选色。

纸牌面 `PaperGameCard.vue` 是执行节点的独立展示面，`--card-*` 和 `--paper-font-*` 不得扩散到普通对话、设置或 Lite。

### 11.2 Lite：信息密度优先的直角控制台

**任务：**快速读懂运行状态、Agent 链路、执行轨迹和详情，不承担 CRT 氛围。

入口包括 `LiteView.vue`、`LiteView.styles.css`、`useLiteViewController.ts`、`DetailDrawer.vue`、`LiteScrollbar.vue`。

- 根面使用 `--bg`、`--surface` 和 Element Plus `--el-*`；
- 状态栏、轨迹区、历史列表和输入区各自分层；
- 轨迹块的宽度随执行时间增长表达运行进度，不能用持续闪烁替代；
- 多 Agent 使用 lane tab、轨迹行头和同源 tone 联动；
- 工具六色只用于工具分类，不取代主题强调色；
- 自绘滚动条、拖动详情抽屉和可展开输入框必须保持键盘和指针可操作；
- Lite 删除 CRT 扫描线和全屏扫光，只保留低成本横格线和有限状态反馈。

### 11.3 桌宠：紧凑角色和状态指示

**任务：**在低占用舞台中表达 Agent 的存在、情绪、上下文和待处理事项。

入口包括 `PetStage.vue`、`PetBubble.vue`、`PetBody.vue`、`PetStatusBar.vue`。

- 舞台背景、网格和光晕可以随主题变化；透明桌面模式只保留 sprite；
- emoji/符号字形、状态条和气泡是桌宠独立语言；
- 气泡按 question、approval、error、feedback、work、speech 区分语义；
- 气泡的圆角和小尺寸是桌宠存量边界，不能复制给工作台、设置或普通弹窗；
- 位置移动用 `quickSetter`，舞台边界由 `ResizeObserver` 缓存；
- 桌宠气泡使用 Markdown `preview`，不能承担主要阅读面。

### 11.4 桌面外壳：Cyber 深空电光窗口系统

**任务：**把多个可独立操作的能力窗组织成有焦点、有层次、有状态反馈的工作区。

入口包括 `CyberDesktopHost.vue`、`CyberWindow.vue`、`WindowFrame.vue`、`ConnectionStatusChip.vue` 和 `useCyberWindowMotion.ts`。

- `--cyber-*` 只属于桌面、窗口、标题栏和任务栏；
- channel、signal、角线、扫描带和任务栏活动标记是外壳识别；
- 当前窗口最小尺寸 `360×260`，原生标题栏高度约 `38–40px`；
- 聚焦使用边框和受控辉光，attention 用待处理状态表达；
- 窗口展开、收起、聚焦和 glitch 经 GSAP，reduced 直接显示最终状态；
- 原生面和浏览器面共享语法，但分别服从 Electron window control 和 workspace state 生命周期。

### 11.5 登录：暗房手电光

**任务：**让用户理解连接目标、鉴权条件、密码可见性和连接结果。

入口包括 `ServerLoginDialog.vue`、`ServerLoginDialog.styles.less` 和 `LampPasswordField.vue`。

- 本地 loopback 和远端服务的字段需求不同，UI 只展示当前需要的字段；
- 密码始终是一个原生 input，只在灯亮时切换 `password/text`；
- 光束是面板级视觉反馈，不能遮住 label、输入内容、错误和按钮；
- 地址、用户名、密码和错误状态都有稳定文字表达，光束只是辅助；
- 全部新增面板、输入和开关默认直角；
- reduced 取消光扫和位移，只保留透明度、聚焦和结果反馈。

### 11.6 设置中心：属性页式配置面板

**任务：**在复杂配置中帮助用户找到目标项、理解影响、修改草稿、保存并处理失败。

入口包括 `SettingsDialog.vue`、`SettingsDialog.styles.less`、`config/shared.less`、`config/neon.less`、`TabShell.vue` 和各 tab。

- 当前 tab 内容才挂载，父级 draft owner 保持未保存数据；
- tab 使用 Win95/98 属性页式边界和低密度霓虹 signature；
- `--neon-cyan`、`--neon-indigo`、`--neon-magenta` 只服务设置中心的 tab 识别和状态装饰；
- 选中态通过 tab color、边界和位置表达，不能只依赖颜色；
- `TabShell` 提供页内说明、toolbar、卡片锚点和分页索引；
- 保存状态、外部配置变化、错误跳转和未保存关闭确认必须是显式状态；
- 面板只挂载当前 tab，避免启动和切换时同时创建所有重型内容。

## 12. 组件、控件和独立调色板

- **按钮**：主按钮使用 `--accent` + `--accent-ink`；幽灵按钮使用主题边框和文字；危险按钮使用 danger 派生色；文字 400。
- **输入框**：新输入框直角、聚焦使用 accent、中文至少 12px；密码灯输入框是登录独立实现。
- **弹窗/抽屉**：使用 `--scrim`、统一 overlay layer 和可回收的 Transition hooks。
- **tooltip/popover**：Teleport 到 body，不能依赖 scoped 继承；正文 400；禁用按钮由外层 span 触发提示。
- **滚动条**：普通内容使用 `.inner-scrollbar()`；Lite 的自绘滚动条是独立组件；隐藏装饰箭头不等于隐藏必要主滚动条。
- **图表**：使用 ECharts，不用 div、CSS 渐变或自绘 SVG 模拟成熟交互。
- **CRT**：只使用 `--nx-*` 和工作台边界。
- **Cyber**：只使用 `--cyber-*` 和桌面窗口边界。
- **Neon**：只使用设置中心的 `--neon-*` 和 tab 语义。
- **Pixi**：只使用 palette，不直接读 CSS 变量。
- **Paper**：只使用 `--card-*`、`--paper-font-*` 和纸牌组件。
- **Lite tone**：只用于节点和工具分类的辅助映射。

独立调色板必须同时满足：有明确界面 owner、有独立语义、不会替代全局交互色、能在浅深主题下保持可读、能随界面卸载，并在本文或对应模块文档中说明边界。

## 13. 开发和 Review 流程

新增或修改 UI 按以下顺序检查：

1. **确定任务面**：这是浏览器工作区、Electron 原生窗、透明桌宠面、工作台、Lite、登录还是设置？
2. **确定状态 owner**：当前状态来自哪个 application port、store、domain projection 或 feature controller？
3. **确定内容优先级**：用户要读什么、做什么、为什么不能做、完成后如何确认？
4. **确定渲染后端**：静态 CSS、CSS 过渡、GSAP、Pixi、Worker 或成熟组件分别负责什么？
5. **接入主题和层级**：复用全局 token、独立命名空间和 overlay contract；不写随机硬编码。
6. **设计降级**：reduced、low、窄窗口、键盘和无 hover 场景仍能完成核心任务。
7. **处理生命周期**：关闭、取消、切换、卸载、隐藏页面和跨窗口同步是否完整回收？
8. **做自动验证**：运行与风险相称的 type-check、lint、单测和 build。
9. **交用户人工验证**：实际布局、触摸、键盘路径、视觉层级和渲染效果由用户查看确认。

## 14. Review 清单

### 14.1 技术结构

- [ ] surface、宿主和窗口类型是否明确？
- [ ] View 是否只组合 controller/presenter，没有直连 service/store？
- [ ] 状态是否只有一个 owner，展示计算是否已纯化？
- [ ] 重型面是否按实际状态异步加载？
- [ ] 组件关闭、卸载和跨窗口切换是否回收 Worker、Pixi、GSAP 和监听？

### 14.2 视觉和交互

- [ ] 新颜色是否来自主题 token、语义变量或已声明独立调色板？
- [ ] 新增控件是否默认直角，是否误用了其他分面的圆角或装饰？
- [ ] 普通内容和按钮是否 400 字重，真实标题是否不超过 600？
- [ ] 中文阅读内容是否至少 12px，工作台是否按 +2 基线处理？
- [ ] 禁用动作是否在渲染期表达原因，并保留提交校验？
- [ ] 状态是否不只靠颜色，错误、阻塞、连接和未保存状态是否有文字？
- [ ] 窄窗口是否先隐藏装饰而不是挤压核心操作？
- [ ] 键盘、焦点、ARIA 名称和 tab/窗口控制行为是否完整？

### 14.3 动效和性能

- [ ] 是否先证明需要动效，再选择 CSS、GSAP 或 Pixi？
- [ ] 是否优先只动画 transform、opacity/autoAlpha？
- [ ] tick 内是否没有布局读取？
- [ ] tween、context、Transition `done()` 和帧订阅是否可回收？
- [ ] system/full/reduced 三种偏好是否都能完成核心任务？
- [ ] high/balanced/low 是否只降低装饰复杂度，不降低交互反馈？
- [ ] 是否使用连续性能样本中的 `sampleCount/p95Ms/maxMs`？

### 14.4 内容和渲染

- [ ] 流式 Markdown 是否走 Worker、240ms 合并、revision 丢弃和终态 flush？
- [ ] 主要阅读面是否使用 full，次要气泡是否明确使用 preview？
- [ ] 用户文本是否保持纯文本，Markdown 是否关闭 HTML？
- [ ] Mermaid、媒体、代码高亮和图表是否使用现有渲染入口？
- [ ] 大数据是否限制可视范围、聚合、分段查询或采样？

## 15. 自动验证与人工验收边界

自动检查负责可以稳定重复的事实：

- `pnpm --filter web type-check`：Vue、TypeScript、模板类型；
- `pnpm --filter web lint`：源码静态规则；
- `pnpm test:web`：前端 Vitest；
- `pnpm --filter web build`：生产构建和分包入口；
- `web/test/styles/colorReadability.test.ts`：颜色可读性；
- `web/test/styles/overlayLayers.test.ts`：层级契约；
- `web/test/performance/*`：动效、质量档、帧协调和 Markdown；
- `web/test/architecture/*`：依赖边界、SFC 预算和设置 tab 约束；
- `git diff --check`：文档和源码空白错误；
- 本地链接、仓库路径和锚点检查：文档引用是否仍可到达。

自动执行者不得启动或操控浏览器/Electron，不得截图、录屏、像素比对、运行浏览器 UI 自动化，也不得把程序化 DOM/CSS 断言登记为视觉验收。实际视觉、布局、触摸、键盘路径、焦点移动和交互反馈由用户人工确认；用户对具体任务明确授权时才改变这个边界。

## 16. 当前治理事项和来源

以下内容是当前已确认的边界，不是新增功能计划：

- `web/src/styles/dialog.less` 当前未被引用，不能作为新弹窗样式入口；
- `--radius-control`、`--radius-panel` 仍有历史消费，新实现不要因为 token 存在而继续使用；
- `WindowFrame.vue` 等历史注释可能保留“暖橙”等旧词，实际颜色以 `theme.css`、`--cyber-*` 和 `--accent` 的当前实现为准；
- 存量圆角、旧窗口样式和局部硬编码在触及对应组件时处理，不进行没有用户目标的全仓批量改写；
- `motion-v` 仍可能出现在依赖清单，但现行 DOM 动效入口是 GSAP；新增 DOM 动效不得重新使用已退役方案。

关键来源：

- [`web-frontend-architecture.md`](./web-frontend-architecture.md)：目录职责、依赖方向、公开面和架构门禁；
- [`vue3-page-building-standard.md`](./vue3-page-building-standard.md)：View、Controller、Presenter、状态、可访问性和测试分层；
- [`docs/frontend/README.md`](../../frontend/README.md)：前端模块入口和专题导航；
- [`web/src/styles/theme.css`](../../../web/src/styles/theme.css)：全局 token、主题和代码高亮；
- [`web/src/styles/overlayLayers.ts`](../../../web/src/styles/overlayLayers.ts)：窗口和 overlay 层级；
- [`web/src/composables/renderQuality.ts`](../../../web/src/composables/renderQuality.ts)：质量档和自适应 governor；
- [`web/src/composables/useRenderedMarkdown.ts`](../../../web/src/composables/useRenderedMarkdown.ts)：流式 Markdown 更新策略；
- [`web/src/main.ts`](../../../web/src/main.ts) 与 [`web/src/App.vue`](../../../web/src/App.vue)：应用初始化和 surface 组装；
- [`web/test/`](../../../web/test/)：前端模型、交互、样式、架构和性能测试。
