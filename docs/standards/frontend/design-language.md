# CheryClaw 前端设计语言规范

> **状态：强制执行。** 本文是 `web/` 所有视觉效果、排版、控件、动效和界面面设计语言的唯一规范入口。
>
> 适用范围：`web/src/**` 的用户可见 UI、Electron 窗口外壳、Pixi 画布和桌宠视觉面。
>
> 代码级事实优先从本文指向的源文件确认；本文整合并取代旧规范 `ui-visual-and-interaction.md`、`font-style-guide.md` 和 `motion-standard.md` 的分散阅读路径。组件职责仍以 [`vue3-page-building-standard.md`](./vue3-page-building-standard.md) 为准，目录与依赖方向仍以 [`web-frontend-architecture.md`](./web-frontend-architecture.md) 为准。

## 1. 设计定位

CheryClaw 是 Vue 3 + Element Plus + GSAP + Pixi.js + Electron 的综合平台。平台不是把所有页面强行做成同一种外观，而是使用同一套全局基础 token，并允许工作台、Lite、桌宠、桌面外壳、登录和设置中心各自表达自己的用途与气质。

全局方向是**深空电光**：深色为深空蓝紫基底 `#0b1020` 加电光青 `#22d3ee`，浅色为冷白基底 `#f5f7fc` 加靛蓝 `#4f46e5`。主题状态由 `web/src/stores/theme.ts` 的 `toggle` / `applyFrom` 维护，`data-theme` 负责切换；浏览器同源窗口通过 storage/BroadcastChannel 同步，接收端只应用、不再次广播。

全局主题 token 的唯一来源是 [`web/src/styles/theme.css`](../../../web/src/styles/theme.css)。新视觉实现先找这里已有的语义变量；组件不得另起一套全局 token，也不得新增未声明的硬编码色相。具有独立身份的模块可以使用独立命名空间，但必须在本文和对应模块文档中明确边界。

## 2. 全局设计 token

### 2.1 色板与表面

以下变量由 `theme.css` 在 `:root`（浅色）和 `[data-theme='dark']`（深色）分别定义：

| 类别 | token | 现行含义与值 |
| --- | --- | --- |
| 文字与强调 | `--ink` | 浅 `#1b2337`；深 `#e8ecf8` |
| 强调色 | `--accent` | 浅 `#4f46e5`；深 `#22d3ee` |
| 强调色上的文字 | `--accent-ink` | 浅 `#f5f3ff`；深 `#04202b` |
| 强调派生 | `--accent-soft` / `--accent-glow` | 浅 `rgba(79,70,229,.1/.18)`；深 `rgba(34,211,238,.16/.25)` |
| 页面/面板/卡片 | `--bg` / `--panel` / `--surface` | 浅 `#f5f7fc` / `#fbfcff` / `#fff`；深 `#0b1020` / `#10162e` / `#161d38` |
| 悬停与半透明表面 | `--surface-hover` / `--surface-soft` | 浅 `#f8fafd` / `rgba(255,255,255,.72)`；深 `#1b2444` / `rgba(140,152,230,.08)` |
| 边框 | `--border` / `--border-strong` | 浅 `rgba(27,35,55,.14/.22)`；深 `rgba(148,163,216,.14/.24)` |
| 遮罩 | `--scrim` | 浅 `rgba(15,23,42,.42)`；深 `rgba(5,8,20,.55)` |
| 语义色 | `--success` / `--danger` / `--warning` / `--info` | 浅 `#15803d` / `#b91c1c` / `#a16207` / `#64748b`；深 `#4ade80` / `#f87171` / `#fbbf24` / `#94a3b8` |
| 其他语义 | `--violet` / `--violet-soft` | ask-user-question 与选中项的紫色文字/淡底 |
| 霓虹签名 | `--neon-cyan` / `--neon-indigo` / `--neon-magenta` | `#5ee7ff` / `#6366f1` / `#d946ef`，浅深主题沿用 |
| 桌面外壳 | `--cyber-desktop-bg` / `--cyber-window-bg` / `--cyber-title-bg` / `--cyber-bar-bg` / `--cyber-line` / `--cyber-line-soft` | 桌面、窗口、标题栏、系统栏和电路线条的主题值，详见 `theme.css` |

`color-mix(in srgb, var(--ink) X%, transparent)` 是文字透明度的现行写法，不为每个透明度另建 token。表面使用深空蓝紫或冷白的梯度，禁止用与基底不同色相的大面积底色。

### 2.2 字体、字号、间距与圆角

- UI 字体是 `--font-ui: Inter, 'Segoe UI Variable', 'PingFang SC', system-ui, sans-serif`。
- 辅助等宽字体是 `--font-mono: 'Fira Code Local', 'Fira Code', 'JetBrains Mono', 'Cascadia Code', 'SFMono-Regular', Consolas, monospace`；`Fira Code Local` 由 `theme.css` 的 `@font-face` 提供。
- 基础字号 token 是 `--text-xs: 11px`、`--text-sm: 12px`、`--text-md: 14px`。中文阅读内容不得小于 `12px`；工作台树/对话/Lite 三视图及其弹窗、输入框、内容文本、窗口外壳、节点弹窗和内容播放器执行字号 **+2px** 的基线修订：正文至少 `14px`，辅助文字至少 `12px`。存量按触及处增量修正，不批量改写。
- 基础间距 token 是 `--space-control: 8px`、`--space-panel: 14px`。
- `--radius-control: 6px`、`--radius-panel: 10px` 是历史 token，实际新实现不能因它们存在而自动使用；全局新实现默认 `border-radius: 0`。代码中仍有少量历史圆角消费，保留到触及该处时处理。
- `--dur-1: .16s`、`--dur-2: .18s`、`--dur-3: .24s`；`--ease-out: cubic-bezier(.16,1,.3,1)`、`--ease-spring: cubic-bezier(.34,1.56,.64,1)`。GSAP 等价语义见第 5 节。

### 2.3 边框、阴影、代码高亮与层级

边框优先用 `--border` / `--border-strong` 或 `color-mix` 派生；辉光使用 `--accent-glow` 或模块自己的已声明调色板。浅深两端的 highlight.js 覆盖在 `theme.css`：浅色使用语义 token，深色为冷色 Tokyo-night 方向——关键词紫、字符串绿、数字橙、标题青、注释灰蓝，允许蓝色，不保留旧暖金规则。

层级契约只由 [`web/src/styles/overlayLayers.ts`](../../../web/src/styles/overlayLayers.ts) 定义：工作区窗口从 `WORKSPACE_WINDOW_Z_INDEX_BASE = 500` 起，每层步进 `WORKSPACE_WINDOW_Z_INDEX_STEP = 2`；应用层 `OVERLAY_Z_INDEX` 为 `canvas 250`、`composer 300`、`composerMenu 320`、`sessionMenu 9900`、`historyDrawer 10000`、`modal 10100`、`approval 10200`、`tooltip 10300`。Nyxus 工作台内部使用 `NYXUS_WORKBENCH_Z_INDEX`：`canvas 0`、`nodeHitTarget 10`、`runCrt 30`、`nodeOverlay 35`、`composer 40`、`blockingInteraction 50`、`chrome 60`、`drawerMask 70`、`drawer 75`、`sidePopover 80`、`connectionMask 90`。Teleported 菜单须通过 `ownerOverlayZIndex()` 跟随所属窗口。

全局 mixin 入口：`markdown.less` 的 `.md-content()`、`scrollbar.less` 的 `.inner-scrollbar()`、`windowControls.less` 的 `.window-control`。[`dialog.less`](../../../web/src/styles/dialog.less) 当前未被引用，是死代码；其中的 `backdrop-filter`、12px 面板圆角等不能视为现行设计规范。

## 3. 全局强制视觉规则

### 3.1 字重与字号

任何 UI 内容默认 `font-weight: 400`；只有页面、窗口、章节或卡片的**实际标题**可以使用 `600`，且不超过 `600`。正文、按钮（包括主按钮）、tip/tooltip/popover、字段 label、角色值、选项、关键词、状态、计数、Markdown 非标题及其中的 `b/strong` 一律 `400`。不能因为标签叫 title，或用了 `b`、`strong`、`legend`，就把它当标题。必须同时检查 `font-weight`、`font` 简写、浏览器默认样式、父级继承和复用组件内部样式；非标题不得用 `500/600/700` 制造层级，应使用位置、留白和主题色。

用户阅读的中文内容（正文、说明、参数值、结果、错误、label）至少 `12px`；正文和表单建议 `13–14px`、行高 `1.5–1.6`。装饰性 `aria-hidden` 图形和纯数字徽标可以更小。旧实现按看到哪里改到哪里修正，不把历史例外带入新增或修改内容。

**Why：**内容加粗会破坏视觉层级和阅读节奏；加粗只用于标题是用户明确要求的强制约束。

### 3.2 动作按钮前置禁用（先选后测）

需要前置字段的动作，字段缺失时必须在渲染期直接 `disabled`，并用 `el-tooltip` 包住可触发提示的 `span`，说明具体缺什么；原生 disabled button 本身不会触发 hover/title。多个条件按真实依赖顺序提示第一个缺失项；字段顺序和专用文案由模块文档定义，不在本文硬编码。点击/提交时仍保留校验作为兜底。

**Why：**点击后才提示缺字段会制造一次无效操作；渲染期的不可用状态能在执行前表达真实条件。

### 3.3 直角与主题色

新按钮、卡片、面板、弹层、输入框等默认 `border-radius: 0`。已验收的历史消息气泡、审批按钮等不批量改；确需单元素圆角必须先获用户明确确认，未确认的新圆角视为违规。

高亮、hover、active、选中、主按钮和辉光统一使用 `var(--el-color-primary)`、`var(--accent)` 或 `color-mix` 派生。深色强调 `--accent: #22d3ee`，浅色强调 `--accent: #4f46e5`，随 `data-theme` 翻转。新增 UI 禁止硬编码新的色相；独立模块只能使用已声明的命名空间。

`--accent-ink` 只表示实心 `--accent` 背景上的反色文字，不是普通强调文字色。普通表面、半透明强调底、选中项用 `--ink` 或 `--accent`；实心主按钮必须成对覆盖背景和前景，不能重定义全局白色。分类色只能辅助标记，不能驱动设置正文、按钮和聚焦色。正文对比度至少 `4.5:1`，必要控件和连线至少 `3:1`，按最终混合背景计算；禁用态和纯装饰另行分类。

Element Plus 浅色 primary 在 [`web/src/styles/element/index.scss`](../../../web/src/styles/element/index.scss) 覆盖为靛蓝；深色必须在 `theme.css` 的 `html.dark`（同等特异性）覆盖官方 `#409eff`，否则会被 dark css-vars 覆盖。主题代码级验证是 `pnpm test:web` 和 `pnpm web:type-check`；两端实际渲染由用户人工检查。

### 3.4 统计图表与成熟组件

统计图表统一使用 ECharts，不用 div、CSS 渐变或自绘 SVG 代替；密集柱图优先 Canvas 与 ECharts `dataZoom`，容器填满可用宽度，悬停同一柱的堆叠段联动高亮。大数据限制可视范围，按时间或轮次聚合、分段查询、按需采样，不能把全部原始记录装入浏览器，也不能声称 ECharts 能直接渲染一亿条原始数据。复杂交互先评估现有组件和成熟方案；要新增替代方案或自绘复杂组件，须先说明适用性、依赖成本与限制。

## 4. 字体与字重细则

### 4.1 字重映射表

| 用途 | 字重 |
| --- | --- |
| 页面、窗口、章节、卡片实际标题 | 可用 `600`，不超过 `600` |
| 正文、描述、参数值、选项、输入框、字段标签、角色值、状态、计数 | `400` |
| 全部按钮 | `400` |
| tooltip、popover 正文及正文里的 `b/strong` | `400` |
| Markdown 非标题内容及 `strong` | `400` |

正文、按钮和表单沿用 `--font-ui`；等宽字体仅用于时间、标识等辅助信息，使用 `var(--font-mono)`。代码、`pre`、xterm 相关元素在 `theme.css` 全局使用 `--font-mono`。不得引入另一套字号或颜色 token。

### 4.2 判别与检查

按文字用途判断标题，不按 HTML 标签或名称判断。检查显式规则和隐式继承，尤其是 `font` 简写、浏览器 `b/strong` 默认样式、父级继承和复用组件。非标题不用 500、600、700；用位置、留白和主题色表达层级。中文阅读字号遵守第 2.2 节的 `12px` 下限及工作台 +2 基线。

## 5. 动效规范

### 5.1 引擎、时长与装配

JS 驱动的 DOM 动效唯一使用 GSAP；新增动效使用 GSAP 或 CSS，`motion-v` 已退役。Pixi.js 执行图和 CSS `@keyframes` 维持各自体系，不算 DOM 动画栈。

[`web/src/utils/gsapCore.ts`](../../../web/src/utils/gsapCore.ts) 的 `setupGsapCore()` 只执行一次，设置 `gsap.config({ autoSleep: 120, force3D: 'auto', nullTargetWarn: true })`；禁止写全局 `gsap.defaults()`。语义时长 `MOTION` 为 `feedback .08`、`micro .12`、`control .16`、`panel .22`、`view .28`、`sweep .42`；缓动为 `easeMicro power2.out`、`easePanel power3.out`、`easeExit power2.in`、`easeAgent back.out(1.25)`。CSS token `--dur-1/2/3` 与 `--ease-out/--ease-spring` 表达同一套语义，其中 `expo.out` 近似 `cubic-bezier(.16,1,.3,1)`，`back.out(1.7)` 近似 `cubic-bezier(.34,1.56,.64,1)`。

持续物理更新经 `utils/frameCoordinator.ts` 订阅：首个订阅者接入 `gsap.ticker`，最后一个退出后停止，页面隐藏时暂停；质量采样每个显示帧只执行一次，并使用真实 `performance.now()` delta。

普通组件用 `useGsap(setup, scope?)` 建立 scoped `gsap.context()`；overlay 用 `useOverlayTransitionHooks()` 接入 Vue `<Transition :css="false">`。卸载、取消、反向切换都必须 `kill/revert`，Vue 的 `done()` 只能调用一次。鼠标跟随、拖拽、桌宠位置等高频写入用 `quickTo` / `quickSetter`，不能每帧创建 tween 或更新 Vue 响应式状态触发 patch。

### 5.2 性能铁律与验证

1. 优先只动画 `transform` 和 `opacity/autoAlpha`，避免 `width/height/top/left/margin/padding/filter`。
2. 遮罩不用 `backdrop-filter`；大面积扫描纹理静态，小面积装饰才允许受控循环。
3. `will-change` 只放在真实持续运动元素上，不全局铺设。
4. overlay 关闭、组件卸载或 `document.hidden` 时立即停止无意义帧任务。
5. 宠物舞台边界由 `ResizeObserver` 缓存，tick 内禁止 `getBoundingClientRect()`。
6. 正常场景目标 p95 帧间隔 ≤ `20ms`，压力场景 ≤ `33ms`；降级先减少装饰、DPR 和挂载数量，不人为降低交互反馈帧率。
7. 开发态先调用 `__CHERY_PERF__.reset()`，完成单一连续交互后读取 `__CHERY_PERF__.snapshot().frames`；快照至少有有界 `sampleCount`、`p95Ms`、`maxMs`，不能用最近一帧或主观观感代替 p95。

### 5.3 动效偏好与渲染质量

`useMotionPreference.ts` 定义偏好 `'system' | 'full' | 'reduced'`，默认 `system`：`system` 跟随 `prefers-reduced-motion`；`full` 保留完整位移、缩放、stagger 和受控装饰；`reduced` 保留即时状态反馈和短透明度过渡，取消非必要位移、弹性、stagger 与循环装饰。偏好存入 `chery-motion`，由 storage event 与 BroadcastChannel 同步，并投影到根节点 `data-motion`。

偏好与自适应质量独立。`useMotionTier.ts` 根据 `high / balanced / low` 选择入场形式、幅度、装饰、stagger 和消息入场；`renderQuality.ts` 的档位配置为：high 粒子 `420`、DPR `2`、图 motion `30fps`，balanced 粒子 `300`、DPR `1.5`、图 motion `24fps`，low 粒子 `180`、DPR `1`、图 motion `18fps`。质量用帧预算迟滞升降级，降复杂度而不降低交互帧率；装饰须能在低档关闭或降采样。

### 5.4 Overlay 与流式 Markdown

`useOverlayAnimation.ts` 的语义参数是 dialog `0.18s`、drawer `0.24s`、overlay `0.16s`；dialog 入场为透明度 + 轻微缩放，drawer 为横向位移，必须可中断并安全完成 Vue transition。

所有实时 Markdown 使用 `useRenderedMarkdown()`：首个非空结果立即调度，后续以 `240ms trailing` 合并，终态/流结束强制 flush；解析在共享 Worker，按 revision 丢弃过时响应，并使用字符预算 LRU；Worker 不可用才动态导入主线程解析器。`preview` 默认截断 `MARKDOWN_PREVIEW_LIMIT = 12000`，只给流式气泡和嵌入式小卡等次要预览面；主要阅读面 MessageBubble、LiteMarkdown 和详情正文使用 `full` 全文。禁止在 delta watch 中同步调用 `renderMarkdown()`。Mermaid 不走 Worker，由 `mermaidRenderer.ts` 的 `setupMermaidAutoRender` 在 MutationObserver 中懒加载 SVG，失败保留可见转义原文，安全设置为 `html:false` 与 `securityLevel: 'strict'`。

### 5.5 动效 Review 清单

- [ ] 是否只动画 transform/opacity，tick 内没有布局读取？
- [ ] tween、context、Transition `done()`、帧订阅是否在取消/卸载时完整回收？
- [ ] 高频更新是否使用 quickSetter/quickTo，避免每帧响应式 patch？
- [ ] system/full/reduced 三种偏好是否都可用？
- [ ] 装饰是否接入 render quality，低档可关闭或降采样？
- [ ] 流式 Markdown 是否走 Worker、240ms 合并与终态 flush？
- [ ] 新重型表面是否异步加载，没有进入首屏 chunk？

## 6. 各界面面设计语言

### 6.1 Agent 运行时工作台：Nyxus CRT 终端

入口是 `WorkbenchDialog.scoped.less`、`agentDialog.less`、`nyxusPopoverTheme.less`、`nodeSkins.ts`、`edgeStyles.ts` 和 `ExecutionGraphPixiRenderer.ts`。工作台以 `--nx-*` 作为独立 CRT 命名空间：`--nx-bg`、`--nx-border`、`--nx-text`、`--nx-code-bg`、`--nx-green/yellow/red/blue/cyan/purple` 以及 `--nx-hljs-*`。弹窗 `.crt-shell()` 由扫描线、噪点、偏移 `text-shadow`、顶光带、细边框和终端等宽字体组成；`crt-grain-shift`、`nx-pulse` 等装饰在 reduced 时停用。节点树同时支持圆节点和 `horizontal-signal` 紧凑卡片，Pixi 通过 `PIXI_CANVAS_PALETTES` 重绘。

排版使用终端等宽辅助信息，用户内容遵守全局字号 +2 基线；标题栏、rail、composer 和抽屉以细线、紧凑间距、角括号和状态色组织信息。当前实现保留少量历史圆角：工作台 window、rail、composer、抽屉和历史标签中可见；新工作台样式仍按直角规则实现。动效包括 GSAP overlay/composer 过渡、CSS 状态脉冲、Pixi 边线脉冲和节点效果；隐藏、拖拽、reduced 和低质量档都必须停用或削减装饰。

节点语义色由 `NODE_SKINS` / `NODE_ACCENT_LIGHT` 和 `EXECUTION_EDGE_STYLES` / `LIGHT_EDGE_STYLES` 提供，不能把颜色写进图数据。`nodeSkins.ts` 的节点包括 start、message、user、root-agent、child-agent、tool-batch、fold、return、dispatch、spawn、system、pack、epoch、input、unknown；边按 start、spawn、dispatch、return 和 fork-detail 区分。它是工作台独立调色板例外，适用范围仅是执行图及其详情。

### 6.2 Lite 精简视图：信息密度优先的直角控制台

入口是 `LiteView.styles.css`、`useLiteNodeTones.ts`、`DetailDrawer.vue` 和 `LiteScrollbar.vue`。Lite 根 `.lite-view` 使用 `--bg`、`--surface` 与 Element Plus `--el-*` 变量，继承 `font-weight: 400`，全直角。顶部状态栏、轨迹区、对话列表和输入区分层：列表使用 `--surface` 与淡横格线，输入区使用 `--el-color-primary` 淡底，抽屉使用 Element Plus 背景与边框。

节点色通过 `useLiteNodeTones()` 从 Nyxus 的 `accentForTheme()` 映射到 `--lite-tone-*`，因此用户、主 Agent、子 Agent、工具、返回、委派、创建协作节点和系统事件与节点树同色。工具子类型是 Lite 独有的六色辅助板：`exec` 紫、`read` 灰蓝、`write` 绿、`web` 青、`dispatch` 橙、`other` 金，仅用于工具图标和 type chip，不取代主题强调色。

组件特征是矩形时间块、链路标签、细状态线、节点详情右侧抽屉、可拖动抽屉宽度和自绘细滚动条；`LiteScrollbar` 隐藏原生滚动条，横向轨迹支持纵向滚轮平移，thumb 最小 `28px`，轨道/滑块为 `4px`。Lite 明确删除 CRT 扫描光效，保留可读性优先的横格线；运行状态使用宽度增长、边缘描边和有限色彩反馈，不靠大面积闪烁。`reduced` 关闭颜色过渡和循环状态动画，但保留即时状态反馈。

### 6.3 桌宠：紧凑 emoji 风与状态指示

入口是 `PetStage.vue`、`PetBubble.vue`、`PetBody.vue`、`PetStatusBar.vue`。舞台使用 `--bg`、`--accent`、`--stage-glow-a/b` 和网格/径向光；透明桌面模式清除舞台背景，只保留 sprite。桌宠本体是紧凑的 emoji/符号字形，脸和手用 glyph 字体，状态条显示情绪、上下文和忙碌三点；气泡是小尺寸、圆角、尾箭头和不透明 `--surface` 混合底，按 question/approval/error/feedback/work/speech 区分。这里的圆角、10px 装饰字号和 emoji 形态是桌宠独立的存量装饰边界，不为其他界面复制。

动效由宠物 motion composable、`quickSetter` 位置更新、气泡进出、影子呼吸、睡眠 `zzz` 浮动和状态脉冲组成。舞台边界由 `ResizeObserver` 缓存；拖拽和位置移动不能在 tick 中读布局。桌宠气泡为次要流式预览面，使用 Markdown `preview`。

### 6.4 桌面外壳：Cyber 深空电光窗口系统

入口是 `CyberDesktopHost.vue`、`CyberWindow.vue`、`WindowFrame.vue`、`ConnectionStatusChip.vue` 和 `useCyberWindowMotion.ts`。桌面、窗口、标题栏和任务栏使用 `--cyber-*` token，深空渐变底、网格、噪点、细电路线和 `channel` / `signal` 徽记构成外壳识别。`CyberWindow` 与 `WindowFrame` 均全直角，标题栏使用等宽字体，标题可用 `600`，普通按钮和连接状态文字为 `400`；连接 chip 是当前外壳中保留的胶囊状态组件。

窗口特征包括 38px 标题栏、最小尺寸 `360×260`、可拖动/缩放、最小化/最大化/关闭三键、四角电光线、扫描带、任务栏活动标记和连接点。`useCyberWindowMotion` 用 GSAP 做窗口展开、收起、聚焦辉光和 attention glitch；reduced 直接显示最终状态。`CyberDesktopHost` 的启动遥测仅在 full 入场档运行，噪点透明度和窗口 glitch 像素由 `renderQualityProfile()` 控制。

### 6.5 登录界面：暗房手电光

入口是 `ServerLoginDialog.styles.less` 和 `LampPasswordField.vue`。登录面沿用 Cyber 窗体语法但有自己的“暗房手电光”身份：`rift-panel` 使用 `--panel`、`--cyber-line`、`--accent-glow` 和四角标记；`--lamp-warm` 是用户确认的白偏黄手电光色，浅色模式改为 `--ink` 黑光。所有面板、输入框、开关、错误卡和按钮全直角，正文/按钮 `400`，真实标题和字段标题可按全局规则使用 `600`。

密码输入保持单一原生 input，只在灯亮时切换 `password` / `text`；光束层用 fixed 锥形、`clip-path` 和 `--beam-*` 注入变量，阅读内容在开灯时提升层级保证可读。进出场使用透明度、轻微位移/缩放，按钮 hover 有一次性光扫；reduced 取消光扫和位移，仅保留透明度与状态反馈。

### 6.6 设置中心：霓虹三色签名

入口是 `SettingsDialog.styles.less` 和 `config/neon.less`。设置面板全直角，主色按 tab 使用 `--tab-color` / `--tab-highlight`，全局霓虹签名是 `--neon-cyan`、`--neon-indigo`、`--neon-magenta`。`neon.less` 提供 `.neon-glass()`、`.neon-glass-dark()` 和 `.neon-border()`；常驻 signature 只有灯条，其余霓虹只在 hover/active/进场点亮。

设置采用 Win95/98 属性页式页签：页签三边框、选中页签下探盖住内容顶边线，选中态 `600`，其他正文 `400`。选中页签的 `conic-gradient` 边框通过 `--neon-angle` 以 `neon-spin-border` 旋转；面板、页签和错误区保留紧凑间距及少量历史圆角，新增控件仍遵守全局直角规则。遮罩不使用 `backdrop-filter`，native/embedded 面铺满 WindowFrame body。

## 7. 组件与控件约定

- **Element Plus：** `index.scss` 只编译项目实际使用的组件，并覆盖浅色 `$colors`；实心 primary 按钮成对使用 `--accent` 与 `--accent-ink`。`.el-popper` 全局 `font-weight: 400`，其中 `b/strong` 也为 `400`；`.el-popper.is-dark` 使用 `--panel`、`--ink` 和主题边框，`label-tip-popper` 最大宽度 `260px`、`pre-line` 换行、行高 `1.5`。
- **按钮：** 实心主按钮使用主题强调底与 `--accent-ink`；幽灵按钮透明底、主题边框/文字；危险按钮使用 `--danger` 派生底和边框。所有按钮文字 `400`。有前置条件的按钮按第 3.2 节渲染期禁用并由 tooltip 说明缺失项。
- **输入框：** 新输入框直角，底色使用 `--surface`/Element Plus 语义变量，聚焦边框使用 `--accent`，文字 `400`，中文至少 `12px`；密码灯输入框是登录界面独立实现。
- **弹窗、抽屉、overlay：** 使用 `--scrim` 和 `OVERLAY_Z_INDEX`；持续动画场景的遮罩不使用 `backdrop-filter`。Vue overlay 动效接 `useOverlayTransitionHooks()`；native/embedded 面改为相对 WindowFrame body 的 absolute，不能覆盖标题栏三键。
- **popper/tooltip：** Teleport 到 body，不能依赖 scoped 继承；统一 400，使用全局主题背景和文字。禁用按钮的提示必须由外层 `span` 触发。
- **滚动条：** 内层内容使用 `.inner-scrollbar()`，默认 `4px`；Lite 的 `LiteScrollbar` 是可拖拽自绘滚动条；全局隐藏原生上下箭头和滚动条角，不等于隐藏必须可操作的主滚动条。
- **窗口三键：** `windowControls.less` 统一最小化、最大化/还原和关闭图标；WindowFrame/CyberWindow 保持 38–40px 标题栏和 no-drag 按钮区。关闭 hover 使用危险色，focus-visible 使用主题 outline。

## 8. 特殊视觉与独立调色板

1. **CRT 终端：** `.crt-shell()` 使用 `--nx-*`、扫描线、噪点、`text-shadow` 和直角边框；Nyxus popover、审批和提问面使用该身份。`theme.css` 的 `--nx-*` 浅深变体是唯一全局 CRT token。
2. **霓虹：** `--neon-*` 只服务设置中心的三色 signature；不是全局主强调色，主交互仍走 `--accent`。
3. **Pixi：** Canvas 不读取 CSS 变量，必须使用 `useThemeTokens.ts` 的 `PIXI_CANVAS_PALETTES.light/dark`；主题改变时由 `setPalette()` 重画静态层并重建标签。执行图渲染通过质量档控制 DPR、标签分辨率、边脉冲段数、effect node 数量和 ticker。
4. **节点 tone：** Nyxus 节点/边使用 `nodeSkins.ts`、`edgeStyles.ts` 的语义映射；Lite 使用 `useLiteNodeTones.ts` 的 `--lite-tone-*` 映射；Lite 工具六色仅用于工具分类。
5. **HYPixel 纸牌：** `PaperGameCard.vue` / `PaperGameCard.styles.less` / `paperCardModel.ts` 提供执行节点的纸牌表现面。它使用 `--card-*` 与 `--paper-font-*` 独立变量：纸张底、深棕边框、像素图标、状态 ribbon、属性格、技能槽、过程轨道和侧边情报卡；`PaperCardKind` 包括 adventurer、arcanist、companion、skill、treasure、quest、notice、journal、anomaly。卡片有 `card-block-enter`、`paper-spark`、侧卡滑入和 hover 位移动效，`is-quiet-motion` 与 `prefers-reduced-motion` 会关闭装饰和循环动效。它是工作台声明的纸牌独立调色板，颜色和组件边界不能扩散为全局 token。
6. **Lite 对 CRT 的删除决定：** Lite 已删除 CRT 扫描线和全屏扫光（`LiteView.styles.css`），因为它们覆盖正文、降低阅读清晰度；Lite 只保留信息区横格线和低成本状态反馈。

## 9. 总体 Review 清单

### 9.1 全局视觉与交互

- [ ] 新 UI 默认字重是否为 `400`？`600` 是否只用于真实标题，正文、选项、标签、按钮、计数均无加粗？
- [ ] tip/tooltip/popover 正文及 `b/strong` 是否为 `400`，没有依赖宿主继承？
- [ ] 有前置字段的动作按钮是否渲染期 disabled，并由外层 tooltip 说明缺什么？
- [ ] 多个前置条件是否按模块真实依赖顺序提示？
- [ ] 新增/修改 UI 是否出现未经确认的圆角？默认是否为 `border-radius: 0`？
- [ ] 新增颜色是否来自主题 token、语义变量或 `color-mix`，没有新的硬编码色相？
- [ ] hover/active/selected 是否使用双极强调色？
- [ ] `--accent-ink` 是否只用于实心 accent 底上的反色文字？正文对比度是否至少 `4.5:1`，必要控件和连线至少 `3:1`？
- [ ] 浅深代码高亮是否保持冷色系可读，没有旧暖金残留？
- [ ] 中文阅读内容是否至少 `12px`，工作台是否按 +2 基线处理？
- [ ] 统计图表是否使用 ECharts，密集数据是否限制视野、聚合或采样？

### 9.2 动效与性能

- [ ] 是否只动画 transform/opacity，tick 内没有布局读取？
- [ ] tween、context、Transition `done()` 和帧订阅能否在取消/卸载时完整回收？
- [ ] 高频更新是否使用 quickSetter/quickTo，避免每帧响应式 patch？
- [ ] system/full/reduced 三种偏好是否都可用？
- [ ] 装饰是否接入 high/balanced/low，低档可关闭或降采样？
- [ ] 流式 Markdown 是否走 Worker、240ms trailing 合并、revision 丢弃和终态 flush？
- [ ] 新重型表面是否异步加载，没有进入首屏 chunk？
- [ ] 是否先调用 `__CHERY_PERF__.reset()`，再用快照中的 `sampleCount/p95Ms/maxMs` 判断帧间隔？

### 9.3 界面面

- [ ] 工作台是否只在 Nyxus/执行图边界使用 `--nx-*`、节点 tone 和 Pixi 独立调色板？
- [ ] Lite 是否保持全直角、400 字重、Element Plus `--el-*` 体系、节点同源 tone、工具六色和无 CRT 扫描线？
- [ ] 桌宠是否保持紧凑 emoji 风、状态条、气泡圆角和透明桌面模式边界？
- [ ] 桌面外壳是否保持 `--cyber-*`、channel/signal 徽记、全直角窗口和任务栏层级契约？
- [ ] 登录是否保持暗房手电光、密码 type 切换、全直角和光束可读层级？
- [ ] 设置是否保持霓虹三色低密度 signature、属性页式 tab 和全直角新增控件？

### 9.4 自动验证边界

自动回归只做单元/组件测试、类型检查、静态检查和构建。自动执行者不得启动或操控浏览器/Electron，不得截图、录屏、像素比对、运行浏览器 UI 自动化，也不得把程序化 DOM/CSS 断言登记为 UI 层验收。实际视觉、布局、触摸、键盘路径和交互反馈由用户人工查看并给出结论；用户对具体任务另有明确授权时才可改变此边界。

## 10. 修订与来源记录

本文承接的现行强制条款来自 `ui-visual-and-interaction.md` v1.7、`font-style-guide.md` 和 `motion-standard.md`：包括字重 400/600、先选后测、直角、深空电光双极色、冷色 hljs、GSAP 唯一 DOM 引擎、帧协调、组件回收、性能 p95、三档动效偏好、渲染质量、流式 Markdown 和各自 Review 清单。

关键裁决见 [`decisions.md`](./decisions.md)：2026-09 将暖金改为深空电光双极色，并允许模块声明独立调色板；GSAP 取代 motion-v，Pixi 和 CSS keyframes 保持各自体系。v1.7 还明确自动回归不得截图或运行 UI 自动化。工作台字号 +2 基线的修订记录见 [`mcu-lite-workbench-ui.md`](../../frontend/mcu-lite-workbench-ui.md)。
