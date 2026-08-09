import { describe, expect, it } from 'vitest'
import { OVERLAY_Z_INDEX } from '../../src/styles/overlayLayers'

describe('overlay layer contract', () => {
  it('keeps history above canvas, node overlays and composer but below true modals', () => {
    expect(OVERLAY_Z_INDEX.canvas).toBeLessThan(OVERLAY_Z_INDEX.nodeOverlay)
    expect(OVERLAY_Z_INDEX.nodeOverlay).toBeLessThan(OVERLAY_Z_INDEX.runCrt)
    expect(OVERLAY_Z_INDEX.runCrt).toBeLessThan(OVERLAY_Z_INDEX.composer)
    expect(OVERLAY_Z_INDEX.composer).toBeLessThan(OVERLAY_Z_INDEX.historyDrawer)
    expect(OVERLAY_Z_INDEX.historyDrawer).toBeLessThan(OVERLAY_Z_INDEX.modal)
    expect(OVERLAY_Z_INDEX.historyDrawer).toBeLessThan(OVERLAY_Z_INDEX.approval)
  })
})
