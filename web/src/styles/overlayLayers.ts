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
  nodeOverlay: 20,
  runCrt: 30,
  composer: 40,
  blockingInteraction: 50,
  chrome: 60,
  // 工作台内右侧抽屉（待处理交互）：高于 chrome，覆盖右侧 rail 与 ctx-bar；
  // 但抽屉 top 从标题栏下方（40px）开始，永远不遮上方关闭/最大化/最小化按钮。
  drawerMask: 70,
  drawer: 75,
} as const
