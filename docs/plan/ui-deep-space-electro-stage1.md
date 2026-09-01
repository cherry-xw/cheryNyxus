# 前端「深空电光」科技感重构 · 阶段1需求计划

> **状态**：执行中（2026-09-01 启动）。
> **目标**：前端 UI 科技感重构——GSAP 动效体系 + 深浅色双主题适配，硬约束浏览器运行 **≥30fps**。
> **进度追踪**：每完成一步将对应 `- [ ]` 更新为 `- [x]`，随该步 commit 一并入库。
> **配套规范**：视觉条款见 [ui-visual-and-interaction.md](../standards/ui-visual-and-interaction.md) v1.4；动效规范见 [motion-standard.md](../web/motion-standard.md)。

## 已确认的四项决策

| 决策项 | 结论 |
|---|---|
| 视觉方向 | **深空电光全新色系**：深色 = 深空蓝紫底 `#0b1020` + 电光青 `#22d3ee` 高亮；浅色 = 冷白 + 靛蓝 `#4f46e5`。暖金 `#f6b73c` 弃用（裁决见 [decisions.md](../standards/decisions.md)） |
| 重构范围 | **渐进式分期**：阶段1 = token 体系（全局换色）+ GSAP 基建 + 流式性能治理 + AgentDialog 样板；阶段2+（后续确认）= 工作台/设置/抽屉/登录/lite 逐面深化 |
| 动画栈 | **统一迁移 GSAP**：motion-v 全部用法迁移后删依赖 |
| 性能治理 | **一并做**：4 处 per-delta markdown 无节流重渲 + 2 个无上限 rAF + 每帧 getBoundingClientRect |

**不动边界**（架构测试锁死）：`services/`、`packages/protocol`、`stores/`、`application/` 门面、`utils/` 行为语义；`domain/` 仅 pets/motion 描述符数据结构可改。无新路由。

## 步骤总览

```
S0 read-proof + 文档先行 → S1 token 体系 → S2 GSAP 基建 → S3 markdown 节流
→ S4 motion-v 迁移 → S5 宠物 rAF 收编 → S6 AgentDialog 样板 → S7 收尾 → S8 验证
```

排序理由：S3 与 S4/S5 文件不相交，提前做最早兑现 ≥30fps；S5 必须在 S4 后（PetBody transform 写入路径只改一次）。

**执行纪律**：每步完成后独立 commit（commit 前跑 `pnpm -C web type-check` + 该步相关测试）；S1 token 单独成 commit（最大风险单元最先隔离，`git revert` 一次全局还原配色）。

## S0 read-proof 与文档先行

- [x] 读 `docs/standards/` 操作声明 + 相关规范，`.claude/read-proof/` 写时分秒凭证
- [x] 创建本计划文档（`docs/plan/ui-deep-space-electro-stage1.md`）
- [x] 修订 `docs/standards/ui-visual-and-interaction.md`（v1.4）：§4 主题色调改「深空电光双极强调」，字重/直角条款不变
- [x] `docs/standards/decisions.md` 追加裁决（暖金弃用 → 深空电光）
- [x] 新增 `docs/web/motion-standard.md`（GSAP 动效规范）
- [x] `docs/web/font-style-guide.md` 补等宽 HUD 字体条目
- [x] `docs/standards/README.md` 索引版本号同步

## S1 深空电光 token 体系（独立 commit）

- [x] `web/src/styles/theme.css` 重写：深浅双套新色值（骨架与块序不变——EP dark css-vars 先于 theme.css、hljs 浅块先于深块）
- [x] `web/src/styles/element/index.scss`：primary `#4f46e5` + 语义色浅色值
- [x] theme.css `html.dark` 块：primary `#22d3ee` + light-3..9 重导 + 新增 `--el-bg-color`/`--el-bg-color-overlay`
- [x] hljs 深色块整组换冷色系（Tokyo-night 方向）；浅色块删过时注释
- [x] `web/electron/main.ts` 托管窗 `backgroundColor: '#16181d'` → `'#0b1020'`（+ 托盘图标换电光青）
- [x] JS 侧 `f6b73c` 清扫：`useSettingsDialogController.ts`、settings `constants.ts`、`LabelTip.vue`、`MediaInlineRenderer.vue`、`useThemeTokens.ts`、`App.vue` attention 样式；另收敛 Workbench/Capsule/WindowFrame attention 荧光边 keyframes（`rgba(246,183,60,…)` → `var(--accent-glow)`/`color-mix`）
- [x] `docs/web/workbench-multi-window.md:126` 暖橙 attention 描述同步
- [x] 新增动效 token：`--dur-1/-2/-3`、`--ease-out`、`--ease-spring`、`--accent-glow`
- [x] **不动**：`--nx-*` CRT 14 token、`AnchoredRunCrt.vue` 局部变量、PaperGameCard 纸牌调色板、Import 霓虹弹窗、QuestionCard:379-391、`useLiteNodeTones.ts`（lite 面阶段2+）、MessageAvatar 金渐变（S6 触碰时收敛）

token 主表（深色 / 浅色）：

| 层 | token | 深色 | 浅色 |
|---|---|---|---|
| 基底 | `--bg` | `#0b1020` | `#f5f7fc` |
| 表面 | `--panel`/`--surface`/`--surface-hover`/`--surface-soft` | `#10162e`/`#161d38`/`#1b2444`/`rgba(140,152,230,.08)` | `#fbfcff`/`#fff`/`#f8fafd`/`rgba(255,255,255,.72)` |
| 文字 | `--ink`/`--accent`/`--accent-ink`/`--accent-soft`/`--accent-glow`(新) | `#e8ecf8`/`#22d3ee`/`#04202b`/`rgba(34,211,238,.16)`/`rgba(34,211,238,.25)` | `#1b2337`/`#4f46e5`/`#f5f3ff`/`rgba(79,70,229,.10)`/`rgba(79,70,229,.18)` |
| 边框 | `--border`/`--border-strong`/`--scrim` | `rgba(148,163,216,.14)`/`.24`/`rgba(5,8,20,.55)` | `rgba(27,35,55,.14)`/`.22`/`rgba(15,23,42,.42)` |
| 语义 | success/danger/warning/info/violet/violet-soft | `#4ade80`/`#f87171`/`#fbbf24`/`#94a3b8`/`#c4b5fd`/`rgba(129,140,248,.16)` | `#15803d`/`#b91c1c`/`#a16207`/`#64748b`/`#6d28d9`/`rgba(124,58,237,.08)` |
| 装饰 | `--neon-cyan/indigo/magenta` | 保留现值 | 同 |

浅色用靛蓝非电光青深变体：电光青在冷白底对比度 ~2:1 不足，靛蓝 ~6:1。字号/间距 token 本次不补（会改所有面布局密度，属阶段2+）。

## S2 GSAP 基建

- [x] `web/` workspace `pnpm add gsap`（声明 ^3.13，pnpm 解析落地 ^3.15.0；阶段1 只引核心不注册插件）
- [x] 新 `web/src/utils/gsapCore.ts`：`gsap.defaults`（dur-2/expo.out 默认）+ `setupGsapCore()` 由 `main.ts` 调用一次 + `gsap.ticker.add` 接 `reportDisplayFrame`；不设 ticker.fps 上限（≥30fps 约束，降级走效果裁剪）；`MOTION` 常量镜像 `--dur-*`/`--ease-*` token
- [x] 新 `web/src/composables/useGsap.ts`：`useGsap(setup, scope?)`（onMounted → gsap.context；onUnmounted → ctx.revert）+ `useQuickTo`（懒创建 quickTo，卸载 kill 内部 tween）
- [x] 新 `web/src/composables/useMotionTier.ts`：三档效果映射（high 全量 / balanced 幅度减半 + CSS var `--motion-amplitude` / low 仅 opacity + 装饰 display:none；stagger 0.04/0.02/0；messageEnter true/true/false）
- [x] `web/vite.config.ts` manualChunks：新增 gsap 分支（vendor-gsap）；motion-v 分支保留至 S4 迁移完成后随 S7 删除，避免迁移完成前 motion-v 落入主包

## S3 markdown 流式节流治理

- [ ] 新 `web/src/composables/useThrottledMarkdown.ts`（从 PaperGameCard.vue:157-181 提炼；leading + 240ms trailing + onScopeDispose；cap 截断）
- [ ] 接入 `MessageBubble.vue:94`（不截断）
- [ ] 接入 `useStreamBubble.ts:82`（不截断；scrollTop watch 改 renderedContent → ≤4Hz）
- [ ] 接入 `AnchoredRunCrt.vue:191+202`（cap 12000）
- [ ] 接入 `LiteMarkdown.vue:17`（cap 12000）
- [ ] `PaperGameCard.vue` 删本地实现改引共享 composable

## S4 motion-v → GSAP 迁移（10 文件）

分层：`domain/pets/motion/animation.ts` 改框架中立纯数据描述符；GSAP 执行器放新 `features/pets/composables/usePetMotion.ts`。

- [ ] `domain/pets/motion/animation.ts` 中立描述符化（keyframes + transition，签名不变）
- [ ] 新 `features/pets/composables/usePetMotion.ts`（yoyo/keyframes/elastic spring/xPercent 定位/重建）
- [ ] `PetBody.vue` / `PetFaceFlip.vue`：MotionSpan → span ref + useGsap
- [ ] `PetBubble.vue` + `PetBubbles.vue`：AnimatePresence → Transition :css=false + 钩子
- [ ] `AgentDialog.vue:521-546`：Transition + enter 钩子（overlay autoAlpha 0.16 + panel autoAlpha+y+scale 0.18 power3.out）
- [ ] `HistoryDrawer.vue` + `useHistoryDrawerPanelController.ts` 同模式
- [ ] `useSettingsDialogController.ts`：opacity+y only（保留防抖动约束）
- [ ] `useWorkbenchDialogController.ts` 同模式
- [ ] `composables/useOverlayAnimation.ts` → `useOverlayTransitionHooks` 工厂（useOverlayClick 保留）

## S5 宠物 rAF 收编 + readBounds 缓存

- [ ] `usePetWorld.ts`：裸 rAF → gsap.ticker；readBounds → ResizeObserver + resize 监听 + 初读
- [ ] 位置写入直写化：PetSprite 注册 quickSetter（Map<instanceId, setter>），tick 后直写 transform；`usePetStyles.ts:64-72` style computed 移除 transform
- [ ] 次级锚定降频：speech/approval/todoPanel/petIcons 样式改 ≥120ms pose 快照（~8Hz）
- [ ] `useStandaloneNyxusMotion.ts` 同模式
- [ ] 时间线选择器重分配**不做**（阶段2+ 候选）

## S6 AgentDialog 样板重做

- [ ] 拆 `useAgentDialogController.ts`（script 逻辑 ~500 行）；`AgentDialog.vue` 收敛 View（≤400 行）
- [ ] 视觉：全直角 + 角括号（::before/::after L 形角线，弃 clip-path）+ 顶缘 2px 电光线 + HUD 等宽微文本 + 静态扫描线（不做循环动画）+ 遮罩无 backdrop-blur
- [ ] GSAP 动效：open/close（含 600ms 横扫，low 档禁）、消息进入 stagger（仅非虚拟列表）、流式光标 CSS blink、拖拽 useQuickTo、发送反馈、视图切换淡入
- [ ] 主题切换入口：head-actions ☀/☾ 调 themeStore.toggle()（native 面隐藏）
- [ ] 样式外置 `.scoped.less/.popovers.less/.editor.less` 重写

## S7 收尾

- [ ] `grep -rn "motion-v" web/src` 零命中 → 删 `web/package.json` motion-v 依赖 + lockfile
- [ ] 构建确认 vendor-gsap 产出、无孤儿 vendor-motion
- [ ] `docs/web/renderer.md` 等 motion-v 表述更新

## S8 最终验证

- [ ] `pnpm -C web type-check`
- [ ] lint：`Delete ␍` 存量基线对比不新增；新文件 LF
- [ ] `pnpm test:web`：架构三测试（dependencyBoundaries/vueSfcSizeBudget/bundleBoundaries）+ 主题/PaperGameCard 相关；旧色值断言修正
- [ ] `pnpm -C web build`：vendor-gsap 产出
- [ ] 浏览器手动：三面深浅切换（持久化、无浅色闪屏）、AgentDialog 全交互、纸牌/导入弹窗/QuestionCard 观感目检
- [ ] 性能：DEV 流式长回答期间 `__CHERY_PERF__.snapshot()` 帧间隔 p95 < 33ms；多宠物 + 流式叠加；low 档只裁装饰不掉帧
- [ ] Electron：托管窗无灰边、主题 IPC 双向同步、透明宠物窗不受影响

## 风险与回滚

- 每步独立提交；S1 单独 commit → `git revert` 一次全局还原配色
- token 联动：EP light-3..9 派生对比度逐组件目检；hljs 冷色可读性；PaperGameCard/Import 弹窗/QuestionCard/TABS 多彩 tab 共存观感（目检记录，阶段2+ 调）
- 迁移回归：AnimatePresence→Transition 语义差（exit 期间 v-if、tab 切换时序、ESC 竞态）逐 overlay 手验；spring→elastic 手感；quickSetter 注册表泄漏（卸载必须反注册）；context 外 tween 不被 revert；xPercent/yPercent 与 CSS left/top 冲突（PetBubble）
- 禁忌复核（每步收尾）：样式装配顺序（main.ts:1-6）；透明窗 color-scheme 锁 + 禁铺底色；遮罩禁 backdrop-blur；不动 services/stores/application/domain 行为

## 阶段2+ 展望（本次不做，后续确认）

工作台/设置中心/抽屉/登录/lite 逐面深化；时间线投影节流（features 层包装）；拖拽全面 quickTo 化；GSAP 插件按需引入（Flip/Observer/ScrambleText/SplitText）；nyxus CRT 与纸质卡牌融入全局语言。
