/** Shared application overlay contract. Local component z-index values stay inside these tiers. */
export const OVERLAY_Z_INDEX = {
  canvas: 250,
  nodeOverlay: 290,
  runCrt: 295,
  composer: 300,
  historyDrawer: 360,
  modal: 380,
  approval: 400,
} as const
