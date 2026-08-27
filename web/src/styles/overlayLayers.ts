/** Shared application overlay contract. Feature-local layers use their own stacking context. */
export const OVERLAY_Z_INDEX = {
  canvas: 250,
  composer: 300,
  composerMenu: 320,
  historyDrawer: 360,
  modal: 380,
  approval: 400,
} as const

/** Layers inside the Nyxus workbench. They never compete with application overlays directly. */
export const NYXUS_WORKBENCH_Z_INDEX = {
  canvas: 0,
  nodeHitTarget: 10,
  // 节点 hover 详情需盖住 CRT 显示（runCrt 30），但低于阻塞交互（blockingInteraction 50）。
  nodeOverlay: 35,
  runCrt: 30,
  composer: 40,
  blockingInteraction: 50,
  chrome: 60,
  // 工作台内右侧抽屉（待处理交互）：高于 chrome，覆盖右侧 rail 与 ctx-bar；
  // 但抽屉 top 从标题栏下方（40px）开始，永远不遮上方关闭/最大化/最小化按钮。
  drawerMask: 70,
  drawer: 75,
  // Right-rail popouts must remain above workbench drawers such as pending operations.
  sidePopover: 80,
  // Connection loss is a true blocker and must stay above every interactive workbench surface.
  connectionMask: 90,
} as const
