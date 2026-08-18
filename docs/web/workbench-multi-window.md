# 节点树工作台多窗口化（Part 2）实现汇总

> 本文档记录节点树工作台从**单实例**改造为**每预设一窗**多窗口架构的完整实现细节。需求确认见记忆 `workbench-multi-window-plan`；Part 1（待处理交互右侧抽屉）已单独落地，见 `AgentDialog.vue`/`overlayLayers.ts`。

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