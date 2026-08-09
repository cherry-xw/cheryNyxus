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
} as const
