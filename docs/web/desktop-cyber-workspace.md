# 赛博桌面工作区（Cyber Workspace）

> 记录浏览器面"赛博 OS 多窗口桌面"层（commit `143af38` 引入）的窗口模型与桌面 chrome 契约。Electron 原生独立窗（settings/workbench）见 [workbench-multi-window.md](./workbench-multi-window.md)——两层互不替代：Electron 面窗口外壳归 `WindowFrame`，浏览器面功能窗外壳只归 `CyberWindow`。

## 组件与模型

- `web/src/features/desktop/CyberDesktopHost.vue`：桌面装配层——系统栏、任务栏、进程轨、功能窗渲染、视觉事件横幅。
- `web/src/features/desktop/CyberWindow.vue`：浏览器功能窗唯一外壳（标题栏、层级、最小化/最大化/恢复、拖拽/缩放）。嵌入内容（Agent/History/Settings 等）必须为无壳 `embedded` 态铺满内容区，禁止出现"双壳"。
- `web/src/stores/workspace/windowModel.ts`：纯窗口模型（类型、几何、层级、焦点、最小化、最大化、恢复、持久化）。业务数据留在既有 canonical state，窗口模型只承载 UI 事实。
- `web/src/stores/workspace/uiState.ts`：窗口注册表与 actions；`focusWorkspaceWindow` 维护 z 序（`workspaceWindowOrder`，末尾=最上）。
- `web/src/features/desktop/visualEvents.ts`：桌面视觉事件（故障横幅等）。

## 任务栏展示序契约（2026-09-02 返工）

**任务栏展示顺序与窗口 z 序分离**：

- `WorkspaceWindowState.sequence`：创建时分配的单调递增序号；restore 旧持久化（无 sequence 字段）按数组下标兜底赋值。
- `workspaceWindowsTaskbarList`（computed）：按 `sequence` 稳定排序，**仅供任务栏/进程轨展示消费**。
- `focusWorkspaceWindow` 维持既有语义：把焦点窗口移到 `workspaceWindowOrder` 末尾以置顶层叠——z 序行为不变；**聚焦/切换窗口不得改变任务栏排列**，当前窗口仅以高亮标记（`.active`：accent 边框 + 2px 左侧 accent 竖条），`attention` 高亮闪烁保留。

## 桌面文案语言契约（2026-09-02 返工）

- 用户可见的说明性文案（窗口标题、系统栏按钮、状态、遥测标签、事件标题、底部说明字段）**一律中文**。
- 保留英文白名单：品牌（`CHERY // NYXUS_OS`）、协议码（`FOLD/USR/LLM/TOOL/FORK/RET/BOOT/SYS`、`WINDOW_ERROR` 等）、坐标行装饰（降透明度处理）、状态 class 键（代码标识，非展示文案）。
- 视觉事件标题模板：`错误 // ${code}`（code 保留英文协议码）。

## 系统栏 launcher 收敛（2026-09-04）

- 系统栏 `cyber-launcher` 仅保留「待操作」「设置」两个入口；「路由」「角色」入口及其能力窗移除（路由会话追踪无实际用途；角色在编名单与设置中心 RolesTab 重复）。
- 同步清理：`WorkspaceWindowKind`/`WorkspaceWindowContext` 不再含 `routing`/`roles`；`CyberCapabilityPanel` 仅剩 attention 分支；`browserCapabilityWindows` 只匹配 `attention`。
- 旧持久化布局兼容：布局恢复回调对运行时残留的 `routing`/`roles` 窗口直接丢弃（`restoreWorkspaceLayout(valid)` 过滤），不渲染空窗。

## 约束

- 桌面 chrome 动效遵循 [motion-standard.md](./motion-standard.md)：GSAP 只管 DOM（`useGsap` scoped）；入场/切换只动 transform/opacity；系统栏/任务栏入场接 `useMotionTier`（full 档 stagger、reduced 档仅淡入）。
- 视觉红线遵循 [../standards/ui-visual-and-interaction.md](../standards/ui-visual-and-interaction.md)：全直角、字重 400/600 规则、色走 token。
