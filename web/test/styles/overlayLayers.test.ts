import { describe, expect, it } from 'vitest'
import { NYXUS_WORKBENCH_Z_INDEX, OVERLAY_Z_INDEX } from '../../src/styles/overlayLayers'

describe('overlay layer contract', () => {
  it('keeps workbench menus below drawers and true modals', () => {
    expect(OVERLAY_Z_INDEX.canvas).toBeLessThan(OVERLAY_Z_INDEX.composer)
    expect(OVERLAY_Z_INDEX.composer).toBeLessThan(OVERLAY_Z_INDEX.composerMenu)
    expect(OVERLAY_Z_INDEX.composerMenu).toBeLessThan(OVERLAY_Z_INDEX.historyDrawer)
    expect(OVERLAY_Z_INDEX.historyDrawer).toBeLessThan(OVERLAY_Z_INDEX.modal)
    expect(OVERLAY_Z_INDEX.historyDrawer).toBeLessThan(OVERLAY_Z_INDEX.approval)
  })

  it('keeps passive Nyxus information below input and blocking interactions', () => {
    expect(NYXUS_WORKBENCH_Z_INDEX.canvas).toBeLessThan(
      NYXUS_WORKBENCH_Z_INDEX.nodeHitTarget,
    )
    expect(NYXUS_WORKBENCH_Z_INDEX.nodeHitTarget).toBeLessThan(
      NYXUS_WORKBENCH_Z_INDEX.nodeOverlay,
    )
    expect(NYXUS_WORKBENCH_Z_INDEX.runCrt).toBeLessThan(
      NYXUS_WORKBENCH_Z_INDEX.nodeOverlay,
    )
    expect(NYXUS_WORKBENCH_Z_INDEX.nodeOverlay).toBeLessThan(
      NYXUS_WORKBENCH_Z_INDEX.composer,
    )
    expect(NYXUS_WORKBENCH_Z_INDEX.composer).toBeLessThan(
      NYXUS_WORKBENCH_Z_INDEX.blockingInteraction,
    )
    expect(NYXUS_WORKBENCH_Z_INDEX.blockingInteraction).toBeLessThan(
      NYXUS_WORKBENCH_Z_INDEX.chrome,
    )
    expect(NYXUS_WORKBENCH_Z_INDEX.drawer).toBeLessThan(
      NYXUS_WORKBENCH_Z_INDEX.sidePopover,
    )
    expect(NYXUS_WORKBENCH_Z_INDEX.sidePopover).toBeLessThan(
      NYXUS_WORKBENCH_Z_INDEX.connectionMask,
    )
  })
})
