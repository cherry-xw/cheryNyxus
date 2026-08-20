# 节点树工作台多窗口化（Part 2）实现汇总

> 本文档记录节点树工作台从**单实例**改造为**每预设一窗**多窗口架构的完整实现细节。需求确认见记忆 `workbench-multi-window-plan`；Part 1（待处理交互右侧抽屉）已单独落地，见 `AgentDialog.vue`/`overlayLayers.ts`。

> **2026-08 迁移（Part 3）**：Electron 面工作台/设置改为**原生独立窗**，console 窗废弃，新增跨窗主题同步与深色灰边修复。详见文末 [Electron 原生独立窗迁移（Part 3）](#electron-原生独立窗迁移part-3)。

## 目标

- **每预设一窗**：窗口内经钢琴键/会话列表切换根会话。
- **多窗口布局**：窗口模式可拖动/缩放，多窗口层叠/平铺同时可见，后开的盖前开的。
- **最小化**：缩成「小胶囊」——可拖摆放、多胶囊**层叠**（后缩盖前缩，前一个只露标题）、hover 调整 z 轴悬浮最上、可关闭或还原。
- **标题栏高亮**：收到需用户操作的通知时，窗口标题栏 + 胶囊加高亮闪烁。

## 架构

### Store：窗口注册表（`web/src/stores/agents/ui/uiState.ts`）

新增 `WorkbenchWindowState` 与 per-window actions，窗口 id = **presetId**（每预设一窗，重开复用状态）：

```ts
interface WorkbenchWindowState {
  id: string; presetId: string
  chatId: string | null       // 当前根会话（钢琴/会话列表切换）
  view; minimized              // 胶囊态
  mode; position; size        // 窗口几何
  capsulePos                  // 胶囊摆放位置（可拖，持久化）
  historyDrawerStack; historyDrawerMode; historyDrawerAnchor
  focused; zOrder; attentionBlink
}
```

- refs：`workbenchWindows`、`workbenchWindowOrder`（末尾=最上）、`focusedWorkbenchWindowId`
- actions：`openWorkbenchWindow(presetId)` / `closeWorkbenchWindow` / `focusWorkbenchWindow` / `setWorkbenchWindowMinimized/Chat/View/Geometry/CapsulePos/Blink/Drawer/WorkspaceBrowser`
- computed：`workbenchWindowsList`

### 数据层：多根观察（`web/src/stores/chats/index.ts`）

移除模块级单例 `observedRootChatId`/`rootObservationEpoch`，删除 `closeStaleRootSubscriptions`，简化 `closeRootTimeline`/`observeRootTimeline` 支持并发多根订阅。底层 `rootSubscriptions` 本就按根 keyed，是历史硬阻塞，现可同开多根树。

### 根订阅栅栏的终态丢弃修复（2026-08-20）

`applyRootSubscriptionEvent` 的序栅栏三分支：`rootEventSeq <= eventSeq` 按重复静默丢弃 / `rootEventSeq !== eventSeq+1` 判 gap 触发 `reopenRootSubscription`（重拉权威快照）/ 正常路径应用并推进 cursor。

**问题**：Electron 原生独立窗各自独立 renderer + Pinia store，工作台窗打开瞬间的 root 订阅 cursor 基准（`openChat` 的 `eventSeq`）可能落后于跨窗并发事件 → 后续终态事件（`done`/`error`/`turn.completed`/`run.updated{终态}`）落入「重复丢弃」分支时，该 run/turn 若在 `rootTimelineStates` transient 里仍有残留（曾被 delta 建立、终态被丢弃），就永远卡「执行中/工作中」，重启才自愈。

**修复**：丢弃分支不再纯静默——终态事件且 transient 中仍有对应残留时，`flushRootDeltas` 后 `reopenRootSubscription` 重拉权威快照（`openChat` 的 `state.runs` 已空自愈）。判定函数 `isTerminalRootEvent`（`done`/`error`/`turn.completed`/`run.updated` 的 status ∈ `paused|completed|failed`）；残留检查避免无谓重拉（已清理则直接丢弃）。

## 组件

### `WorkbenchDialog.vue`（新，`web/src/features/agent/dialog/`）

自包含窗口组件，`defineProps<{ windowId; presetId }>`。整段 `.workbench-shell` 子树从 AgentDialog 迁入：titlebar、MessageBranchTree、rail、钢琴/角色 popout、右侧待处理抽屉、composer dock、resize handles。

- chatId 来源：`useAgentDialogOptions({ chatId: () => win.chatId ?? null })`，不再读全局单例。
- 几何/视图/最小化写回 per-window store actions。
- 树订阅：`observeRootTimeline(win.chatId, 'tree')`，close 清理。
- 最小化按钮写 `minimized=true`，shell `v-show` 隐藏。

### `WorkbenchCapsule.vue`（新，`web/src/features/agent/dialog/`）

胶囊最小化 UI，`defineProps<{ windowId }>`。App.vue 按 `workbenchWindowsList` 中 `minimized===true` 渲染。

- **可拖**：指针捕获模式（复用 `useWorkbenchWindow.beginPointerInteraction` 风格），写 `setWorkbenchWindowCapsulePos`。
- **层叠**：`stackIndex` = minimized 列表位置，渲染 pos = capsulePos + index×偏移，后缩盖前缩，只露前标题。
- **hover z**：`focusWorkbenchWindow` 提 z 到顶。
- **还原**：`setWorkbenchWindowMinimized(false)` + `focusWorkbenchWindow`（mode/pos/size 保留）。
- **关闭**：`closeWorkbenchWindow`。

### `AgentDialog.vue`（精简）

仅保留「快速发送 composer」单例面板（Pet 单击打开）。移除全部 workbench 子树/脚本/样式。head 的 ⑂ 按钮与待处理抽屉 `@tree` 改为 `openWorkbenchWindow(presetId)`。

### `App.vue`（多渲染）

authenticated 分支保留 `<AgentDialog />`，新增：

```vue
<WorkbenchDialog v-for="win in agents.workbenchWindowsList"
  :key="win.id" :window-id="win.id" :preset-id="win.presetId" />
<WorkbenchCapsule v-for="win in agents.workbenchWindowsList.filter(w=>w.minimized)" ... />
```

（胶囊渲染用 `template v-for` 包裹，避免 `v-for`+`v-if` 同元素作用域问题。）

### 入口：`PetToolbar.vue`

工具栏**第一个按钮**（🌳「工作台」）调 `agents.openWorkbenchWindow(presetId)`。presetId 回退链：`pet.presetId` → `historyList[].presetId`。无 preset 时按钮 `:disabled`。工具栏容器已有 `@click.stop`，不触发生单击 composer。

**打开即恢复会话**：新建窗口初始 `chatId: null`，空树不渲染。入口须在新建窗口时恢复该 preset 活跃根会话——Pet 用 `activeRootForPet(pet)`（`activeRootByPreset` 优先，回退 pet 当前会话），Nyxus 用 `activeNyxusChatId`（空则 `getActiveNyxus()` 取最近/新建）。仅当窗口 `chatId` 为空时设置，已存在窗口重开复用不覆盖当前浏览。

## 通知高亮（Phase E）

- **触发**：`streamRouter.routeNotification` 里 `interrupt`（审批）/`question_batch_requested`（提问）→ `setWorkbenchWindowBlinkForChat(chatId,true)`，遍历窗口匹配 `win.chatId===chatId` 或 chatId 属窗口根会话后代（`collectDescendantChatIds`）；**仅非聚焦窗**置 blink（聚焦窗用户正看着，闪烁属噪音）。
- **熄灭**：标题栏 pointerdown / 胶囊还原时清 blink；`accept`/`rejected`/`question_batch_completed` 后仅当该 chat 无挂起审批/提问批次才熄灭。
- **动画**：`.has-attention` 加暖橙 `#f6b73c` box-shadow 外发光 + 边框脉冲 `@keyframes` infinite 恒开（应用不跟随 `prefers-reduced-motion`，见 `docs/web/settings.md` 动效降级约定）。

## 改动文件清单

| 文件 | 变更 |
|------|------|
| `web/src/stores/agents/ui/uiState.ts` | 窗口注册表 + actions |
| `web/src/stores/agents/ui/streamRouter.ts` | 通知→blink 触发/熄灭 |
| `web/src/stores/chats/index.ts` | 移除根观察单例守卫 |
| `web/src/features/agent/dialog/WorkbenchDialog.vue` | 新：自包含窗口组件 |
| `web/src/features/agent/dialog/WorkbenchCapsule.vue` | 新：胶囊最小化 |
| `web/src/features/agent/dialog/useAgentDialogOptions.ts` | 参数化 chatId 来源 |
| `web/src/features/agent/dialog/useWorkbenchWindow.ts` | 参数化 windowId + per-window key |
| `web/src/features/agent/chat/AgentDialog.vue` | 精简为 composer 单例 |
| `web/src/features/agent/toolbar/PetToolbar.vue` | 工作台 icon 入口 |
| `web/src/App.vue` | 多窗口/胶囊渲染 |

## 保留耦合点 / 未来工作

- **HistoryDrawer 仍为全局单例**：`useHistoryDrawerManager` 单注入，WorkbenchDialog 的 `openHistory`/锚点继续写全局。per-window `historyDrawer*` store 字段未接线（最深依赖，建议独立小步）。
- **loadOptions 全局选项去重**：未引入共享机制，每窗口独立拉一次全局配置（可接受）。
- **Nyxus 窗口**：`NyxusCore` 单击入口现落 composer 面板，经 ⑂/工具栏进工作台；`activeNyxusChatId` 闭包捕获未按窗口参数化（后续如需）。

---

## Electron 原生独立窗迁移（Part 3）

> 2026-08-18。将设置 / 工作台从 console 大窗（单 BrowserWindow 内叠加）迁移为 **Electron 原生独立窗**（每预设一工作台窗），console 窗废弃；同时修复深色模式窗口边缘灰边，并顺带实现跨窗主题实时同步。需求确认见记忆 `electron-native-windows-plan`。

### 动机

- 设置 / 工作台当前渲染在 console 窗（`?surface=console`，1200×800 frameless）内部叠加，用户要求二者为**相互独立**的原生窗。
- 深色模式下窗口四周出现灰色边框：`html.dark` → element-plus dark css-vars → `color-scheme:dark` → Chromium 给根画布涂系统深灰；仅 desktop 透明窗锁了 `color-scheme:light`，其余窗未锁。

### 架构（Electron 面）

**主进程 = 唯一窗口生命周期管理者**：

- `ManagedWindow` 注册表（`web/electron/main.ts`），key = `'settings'` | `'wb:<presetId>'`，惰性创建 / 聚焦 / 复用 / hide 保活。
- 通用 `window:control` IPC，按 `BrowserWindow.fromWebContents(event.sender)` 定位窗口，免传 windowId、防伪造。
- bounds 持久化：`userData/window-state.json`，`move`/`resize` 去抖 400ms 保存，创建时 `screen.getAllDisplays()` 校验贴屏（只存 bounds，不存最大化态）。
- 主题广播：任一窗 `theme:changed` → main 对全部 managed 窗 `theme:set`。

**渲染层四 surface**（App.vue 分发）：

| surface | 内容 |
|---------|------|
| `?surface=desktop` | 桌面透明宠物窗（不变：PetStage/NyxusCore/AgentDialog） |
| `?surface=settings` | 设置原生窗：`WindowFrame`（标题栏三键/主题边框）内嵌 `<SettingsDialog native/>`（native 面隐藏自身 header，标题 + 打开配置文件夹按钮并入 WindowFrame 标题栏） |
| `?surface=workbench&presetId=xx&chatId=xx` | 工作台原生窗（每 preset 一窗）：**同用 `WindowFrame` 公共外壳**——`<WorkbenchDialog native/>` 隐藏自身 `.workbench-titlebar`，标题显示预设名、`attentionBlink` → 标题栏闪烁、关闭经 `defineExpose(closeWorkbench)` 由 WindowFrame `close` handler 接管（先释放根时间线订阅），另渲染 `HistoryDrawer` |
| 无 surface | 浏览器单页（**逐字节不变**：应用内多工作台窗 + 胶囊 + overlay 设置 + 抽屉） |

每个原生窗是独立 renderer，各连一条 WS（后端 `ConnectionManager` 支持多连接）；跨窗状态只经 query（chatId/presetId）+ 少量 IPC（`workbench:open-chat` / `workbench:focus` / `window:focused` / `theme:set`）。

### 窗口生命周期

| 操作 | 设置窗 | 工作台窗 |
|------|--------|----------|
| 点 X 关闭 | **destroy**（无运行状态，重开重载 config） | **hide 不销毁**：WS 与 run 保持、任务继续；重开同 preset → show+focus 还原（任务可见/可继续） |
| 最小化 | 任务栏 | 任务栏，run 继续 |
| 最大化/还原 | 原生（双击标题栏 / Win+↑ / 拖边缘均可） | 同左 |

托盘点击 / `app.activate` / `second-instance`：原打开 console 壳窗 → **改为打开设置窗**（应用主界面锚点）。

### 通用窗口外壳能力（三件套）

- `useWindowFrame.ts`（`web/src/features/desktop/`）：composable，封装 `windowControl` / `onWindowMaximized` / `onWindowFocused` / `flashFrame` / `setBackgroundColor`；含 `lockWindowRootColorScheme()`（置 `documentElement.style.colorScheme='light'` + `<html>` 加 `window-surface` class —— 灰边修复核心）。
- `WindowFrame.vue`：**settings / workbench 公共外壳**。自绘 40px 标题栏（`-webkit-app-region: drag` + 双击最大化）+ 三键 + 主题边框，body slot 铺满；三键行为默认 `windowControl`，可经 `minimize`/`maximize`/`close` prop 覆盖（workbench 关闭先释放订阅），`attention` prop 驱动标题栏闪烁。**标题位置扩展点**：`title-actions` slot 紧贴标题右侧（`.window-frame-title-group` 内、与标题同行垂直居中，容器 `no-drag` 保证可点击）——settings 面在此放「打开配置文件夹」公共组件 `OpenConfigDirButton`（`App.vue` 接入），未来标题右侧功能统一在此 slot 扩展；`titlePointerDown` prop 透传标题栏点击（workbench 熄灭闪烁）。
- `windowControls.less`（`web/src/styles/`）：共享三键样式，从 ConsoleShell / WorkbenchDialog 抽取，统一来源。

settings / workbench 原生窗均包 `WindowFrame` 公共外壳。`WorkbenchDialog` 浏览器路径保留自身 `.workbench-titlebar` 外观（逐字节不变）；`native` 路径隐藏自身标题栏、由外壳承载，仅保留驱动语义：8 向 resize handles 隐藏、`mode` 恒 `'fullscreen'` 铺满、`attentionBlink` → 外壳标题栏闪烁 + `bridge.flashFrame()`。灰边锁定统一由 `WindowFrame.onMounted` 调 `lockWindowRootColorScheme()`。

### 灰边修复（三层统一方案）

1. **color-scheme 锁定**：`lockWindowRootColorScheme()`（settings / workbench 面统一由 `WindowFrame.vue` onMounted 调）对 settings / workbench 面 mount 时锁 `color-scheme:light`（DesktopSurface 既有机制扩展到全部 Electron 窗）。
2. **根画布兜底**（`theme.css`）：`html.window-surface, html.window-surface body, html.window-surface #app { background: var(--bg); }` —— 窗口边缘/圆角/拖拽残影显示主题底色而非系统灰/白。
3. **main 层 backgroundColor**：`theme.ts apply()` 在 Electron 面读当前主题 bg（`#16181d` 暗 / 亮色值）→ `bridge.setBackgroundColor()` → `win.setBackgroundColor()`，兜底首帧与 resize 边缘。

**跨窗主题同步**：`theme.toggle()` 成功后 `bridge.emitThemeChanged()` → main 广播 `theme:set` → 各 Electron 面订阅 `onThemeSet` → `applyFrom(theme)` + 重设 backgroundColor。此前各窗只在启动读 localStorage 不互相同步，本次补齐。**范围边界**：广播仅发 managedWindows（settings / workbench）；desktop 透明窗不接主题桥（`bindElectronThemeBridge` 对 `surface==='desktop'` 直接 return，避免 `setBackgroundColor` 铺不透明底色），主题独立。

### 跨进程盲点修复

desktop 面（桌面透明窗 renderer）此前有三处**直接调 store 打开工作台**，而工作台渲染在 console 窗（另一 renderer、另一 Pinia store）→ 点了无反应。迁移后统一经 `bridge.openWindow({kind:'workbench',...})` → main 建原生窗：

- `PetToolbar.vue` 工作台按钮
- `AgentDialog.openWorkspaceTree`（待处理抽屉「打开节点树」）
- `NyxusCore.openWorkbench` / `openSettings`（本就走 bridge，改新 API）

浏览器 fallback 全部保留现 store 路径（`desktopBridge()` 非 Electron 返回 undefined）。

### 改动文件清单（Part 3）

| 文件 | 变更 |
|------|------|
| `web/electron/main.ts` | 删 console 全套；`ManagedWindow` 注册表 + settings/workbench 工厂 + `window:open/control/set-background/flash`/`theme:changed` IPC + bounds 持久化；托盘/activate/second-instance → 打开设置窗 |
| `web/electron/preload.ts` | 删 `ConsoleTarget`；新 bridge（openWindow/windowControl/onWindowMaximized/onWindowFocused/onWorkbenchFocus/onOpenChat/flashFrame/setBackgroundColor/emitThemeChanged/onThemeSet） |
| `web/src/features/desktop/desktopBridge.ts` | 同上镜像类型 |
| `web/src/features/desktop/useWindowFrame.ts` | 新：通用窗口外壳 composable + `lockWindowRootColorScheme` |
| `web/src/features/desktop/WindowFrame.vue` | 新：自绘标题栏外壳 |
| `web/src/styles/windowControls.less` | 新：共享三键样式 |
| `web/src/App.vue` | surface 四分发；workbench 面同步注册 + focus/open-chat/flashFrame/主题订阅；删 console 分支与 `bindConsoleNavigation` |
| `web/src/features/agent/settings/SettingsDialog.vue` | `native` prop（铺满窗、去自拖拽/自三键、close→windowControl、mounted 加载） |
| `web/src/features/agent/dialog/WorkbenchDialog.vue` | `native` prop（fullscreen 恒置、三键走 windowControl、titlebar drag、resize 隐藏、attentionBlink→flashFrame） |
| `web/src/features/pets/nyxus/components/NyxusCore.vue` | 入口改 `openWindow` |
| `web/src/features/agent/chat/AgentDialog.vue` | 入口改 `openWindow`（含 `openWorkspaceTree` 盲点修复） |
| `web/src/features/agent/toolbar/PetToolbar.vue` | 入口改 `openWindow`（盲点修复） |
| `web/src/features/desktop/ConsoleShell.vue` | 删除 |
| `web/src/stores/theme.ts` | `applyFrom(theme)` + Electron 面 `setBackgroundColor` + `emitThemeChanged` |
| `web/src/styles/theme.css` | `html.window-surface` 兜底背景 |

浏览器面（无 surface）不受影响：`uiState.ts` workbenchWindows 注册表 / capsule / 几何 / `settingsOpen` 全部保留（浏览器多窗口模式照常），Electron 原生面下这些字段自然休眠。
