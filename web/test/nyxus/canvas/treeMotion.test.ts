import { readComponentSource } from '../../helpers/componentSource'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXECUTION_EDGE_PULSE_HEAD_LENGTH,
  EXECUTION_EDGE_PULSE_INTERVAL,
  EXECUTION_EDGE_PULSE_LENGTH,
  EXECUTION_EDGE_PULSE_PERIOD,
  EXECUTION_EDGE_PULSE_SEGMENTS,
  EXECUTION_EDGE_PULSE_SPEED,
  EXECUTION_EDGE_PULSE_TAIL_LENGTH,
  edgePulseVisibleInterval,
  edgePulseDashPattern,
} from '../../../src/features/pets/nyxus/graph/edgeMotion'

async function rendererSource(): Promise<string> {
  return readComponentSource(
    resolve('web/src/features/pets/nyxus/renderer/ExecutionGraphPixiRenderer.ts'),
    'utf8',
  )
}

async function treeComponentSource(): Promise<string> {
  return readComponentSource(
    resolve('web/src/features/pets/nyxus/components/MessageBranchTree.vue'),
    'utf8',
  )
}

async function treeControllerSource(): Promise<string> {
  return readComponentSource(
    resolve('web/src/features/pets/nyxus/components/useMessageBranchTreeController.ts'),
    'utf8',
  )
}

describe('Nyxus tree motion contract', () => {
  it('uses one GPU ticker for all node and edge motion', async () => {
    const source = await rendererSource()

    expect(source).toContain('this.app.ticker.add(this.ticker)')
    expect(source).toContain('this.drawMotion(performance.now())')
    expect(source).toContain('private readonly motionEdges = new Graphics()')
    expect(source).toContain('private readonly motionNodes = new Graphics()')
    expect(source).toContain('if (!this.app || this.reduceMotion || document.hidden) return')
  })

  it('keeps Electron on WebGL while bounding the backing buffer by adaptive quality', async () => {
    const source = await rendererSource()

    expect(source).toContain("if (!isElectronRuntime() && 'gpu' in navigator)")
    expect(source).toContain("preference: 'webgl'")
    expect(source).toContain('return Math.min(dpr, renderQualityProfile(tier).graphDpr)')
    expect(source).toContain("private qualityTier: RenderQualityTier = 'balanced'")
    expect(source).toContain('rendererResolution(this.qualityTier)')
  })

  it('renders fixed-length repeated pulses without SVG animation instances', async () => {
    const renderer = await rendererSource()
    const component = await treeComponentSource()

    expect(renderer).toContain('EXECUTION_EDGE_PULSE_SEGMENTS.forEach')
    expect(renderer).toContain('head += EXECUTION_EDGE_PULSE_PERIOD')
    expect(renderer).toContain(
      'drawSampledSegment(this.motionEdges, edge, visible.start, visible.end)',
    )
    expect(component).toContain('class="tree-gpu-surface"')
    expect(component).not.toContain('<FiberPulseLine')
    expect(component).not.toContain('<animate')
  })

  it('keeps pointer-down and pointer-up outside scene reconstruction', async () => {
    const [component, controller] = await Promise.all([
      treeComponentSource(),
      treeControllerSource(),
    ])
    const dragStart = controller.slice(
      controller.indexOf('function startGpuDrag'),
      controller.indexOf('function retainCameraSelection'),
    )

    expect(controller).toContain('Math.max(480, Math.min(960')
    expect(controller).toContain('viewportRetentionOverscan.value,')
    expect(controller).toContain('const TREE_FULL_RENDER_THRESHOLD_DEFAULT = 150')
    expect(controller).not.toContain('canvas.dragging.value ? DRAG_VIEWPORT_OVERSCAN')
    expect(component).not.toContain(`:class="{ 'is-panning': canvas.dragging.value }"`)
    expect(dragStart).not.toContain('viewportSelectionCamera.value =')
    expect(controller).toContain("viewportRef.value?.classList.add('is-panning')")
    expect(controller).toContain('retainCameraSelection(camera)')
  })

  it('retries the shared reset layout until initial timeline geometry is ready', async () => {
    const [component, controller] = await Promise.all([
      treeComponentSource(),
      treeControllerSource(),
    ])

    expect(controller).toContain('if (!initialFitPending || !timelineSnapshot.value) return')
    expect(controller).toContain('if (resetLayout()) initialFitPending = false')
    expect(controller).toContain('() => layout.value.bounds.maxY')
    expect(controller).toContain('() => viewportSize.value.height')
    expect(component).toContain('@click.stop="resetLayout"')
  })

  it('keeps the enlarged static cache out of the per-frame animation loops', async () => {
    const source = await rendererSource()
    const drawMotion = source.slice(
      source.indexOf('private drawMotion'),
      source.indexOf('destroy(): void'),
    )

    expect(source).toContain('const MOTION_VIEWPORT_OVERSCAN = 120')
    expect(source).toContain('this.refreshMotionItems()')
    expect(drawMotion).toContain('for (const edge of this.visibleMotionEdges)')
    expect(drawMotion).toContain('for (const node of this.visibleMotionNodes)')
    expect(drawMotion).not.toContain('this.sampledEdges')
    expect(drawMotion).not.toContain('this.scene.nodes')
    expect(source).toContain('.filter((node) => node.running || node.detailActive)')
    expect(source).toContain('renderQualityProfile(this.qualityTier).graphEffectNodes')
    // 2026-09-02 二轮返工：priority 分级随类型徽记矩阵移除，motion 预算按 detailActive 排序。
    expect(source).toContain('Number(right.detailActive) - Number(left.detailActive)')
    expect(source).toContain('if (node.detailActive)')
    expect(source).toContain('const MOTION_FRAME_INTERVAL = 1000 / 30')
  })

  it('keeps full-render dragging outside Vue and moves one hit-target layer', async () => {
    const [component, controller] = await Promise.all([
      treeComponentSource(),
      treeControllerSource(),
    ])

    expect(controller).toContain('if (fullRenderActive.value) return')
    expect(component).toContain('class="gpu-node-hit-layer"')
    expect(component).toContain('.gpu-node-hit-layer,')
    expect(component).toContain('.tree-gpu-surface,')
    const dragFrame = controller.slice(
      controller.indexOf('function presentGpuDrag'),
      controller.indexOf('function finishGpuDrag'),
    )
    const dragEnd = controller.slice(
      controller.indexOf('function finishGpuDrag'),
      controller.indexOf('const projectedCrts'),
    )
    expect(dragFrame).not.toContain('gpuRenderer?.setCamera(camera)')
    expect(dragEnd).toContain('snapCrtWindowsToAnchors()')
    expect(component).not.toContain('.gpu-node-hit-target,\n    .crt-anchor-lines')
  })

  it('caps label textures and releases them while a workbench is suspended', async () => {
    const source = await rendererSource()

    expect(source).toContain('return Math.min(profile.graphLabelResolution, Math.max(1, scaled))')
    expect(source).toContain('if (suspended) {')
    expect(source).toContain('this.releaseLabels()')
    expect(source).toContain('this.labels.removeChildren().forEach((child) => child.destroy())')
  })

  it('reuses sampled geometry while refreshing edge runtime state', async () => {
    const source = await rendererSource()

    expect(source).toContain('if (geometryChanged) this.sampledEdges = scene.edges.map(sampleEdge)')
    expect(source).toContain('Object.assign(this.sampledEdges[index]!, edge)')
  })

  it('lets the destination progressively consume the pulse tail after its head arrives', () => {
    expect(edgePulseVisibleInterval(300, 280, 120)).toEqual({ start: 160, end: 280 })
    expect(edgePulseVisibleInterval(300, 320, 120)).toEqual({ start: 200, end: 300 })
    expect(edgePulseVisibleInterval(300, 380, 120)).toEqual({ start: 260, end: 300 })
    expect(edgePulseVisibleInterval(300, 420, 120)).toBeUndefined()

    expect(edgePulseVisibleInterval(300, 320, 8)).toBeUndefined()
  })

  it('centers glyphs from their trimmed painted bounds instead of font baselines', async () => {
    const source = await rendererSource()

    expect(source).toContain('position: { x: node.x, y: node.y }')
    expect(source).toContain('trim: true')
    expect(source).toContain('"Noto Sans Symbols 2"')
    expect(source).not.toContain('position: { x: node.x, y: node.y + 1 }')
  })

  it('keeps horizontal Signal nodes icon-only', async () => {
    const source = await rendererSource()
    const signalLabels = source.slice(
      source.indexOf('private rebuildLabels'),
      source.indexOf('private releaseLabels'),
    )

    expect(signalLabels).toMatch(/if \(signal\) \{\s*continue\s*\}/)
    expect(source).not.toContain('signalNodeLabelFor')
  })

  it('uses a 120px head-tail pulse on one fixed 2.4s generation interval', () => {
    expect(EXECUTION_EDGE_PULSE_SPEED).toBe(100)
    expect(EXECUTION_EDGE_PULSE_INTERVAL).toBe(2.4)
    expect(EXECUTION_EDGE_PULSE_PERIOD).toBe(240)
    expect(EXECUTION_EDGE_PULSE_HEAD_LENGTH).toBe(72)
    expect(EXECUTION_EDGE_PULSE_TAIL_LENGTH).toBe(48)
    expect(EXECUTION_EDGE_PULSE_LENGTH).toBe(120)
    expect(EXECUTION_EDGE_PULSE_SEGMENTS.map((segment) => segment.length)).toEqual([
      120, 108, 96, 84, 72, 40, 8,
    ])

    expect(edgePulseDashPattern(120)).toEqual({ dash: 120, gap: 120, from: 120, to: -120 })
    expect(edgePulseDashPattern(8)).toEqual({ dash: 8, gap: 232, from: 8, to: -232 })
  })

  it('keeps the static line subdued while the pulse head and tail stay luminous', async () => {
    const source = await rendererSource()

    expect(source).toContain('alpha: 0.07 * alpha')
    expect(source).toContain('width: 1.35')
    expect(source).toContain('(edge.active ? 0.52 : 0.38) * alpha')
    expect(source).toContain('[0.12, 0.16, 0.22, 0.3, 0.48, 0.3, 0.55]')
    expect(source).toContain('const DEEMPHASIZED_ALPHA = 0.3')
  })

  it('applies non-core emphasis to graphics, labels, and motion', async () => {
    const source = await rendererSource()

    expect(source).toContain('const alpha = emphasisAlpha(edge.deemphasized, edge.detailBranch)')
    expect(source).toContain('const alpha = emphasisAlpha(node.deemphasized, node.detailBranch)')
    expect(source).toContain('glyph.alpha = alpha')
    expect(source).toContain('title.alpha = alpha')
    expect(source).toContain('termination.alpha = alpha')
    expect(source).toContain('text: String(node.foldCount)')
    expect(source).toContain('foldCount.alpha = alpha')
    expect(source).toContain('const emphasis = emphasisAlpha(edge.deemphasized, edge.detailBranch)')
    expect(source).toContain('const emphasis = emphasisAlpha(node.deemphasized, node.detailBranch)')
  })

  it('gives detail branches a distinct cyan 55% treatment', async () => {
    const [renderer, component] = await Promise.all([rendererSource(), treeComponentSource()])

    expect(renderer).toContain('const DETAIL_BRANCH_ALPHA = 0.55')
    expect(renderer).toContain('detailBranch ? DETAIL_BRANCH_ALPHA : DEEMPHASIZED_ALPHA')
    expect(renderer).toContain('if (node.detailBranch)')
    expect(renderer).toContain('width: 1.8')
    expect(component).toContain('color: detailBranch ? DETAIL_BRANCH_COLOR')
    expect(component).toContain('detailBranch: coreFlowProjection.value.detailNodeIds.has(node.id)')
  })
})
