import { Application, Container, Graphics, Text } from 'pixi.js'
import {
  cameraWorldBounds,
  executionWorldBoundsIntersect,
  type ExecutionCamera,
  type ExecutionWorldBounds,
} from './executionViewport'
import { executionEdgeGeometry, type ExecutionEdgeGeometry } from '../graph/executionGeometry'
import { EXECUTION_ICON_RADIUS } from '../graph/executionLayout'
import {
  EXECUTION_EDGE_PULSE_LENGTH,
  EXECUTION_EDGE_PULSE_PERIOD,
  EXECUTION_EDGE_PULSE_SEGMENTS,
  EXECUTION_EDGE_PULSE_SPEED,
  edgePulseVisibleInterval,
} from '../graph/edgeMotion'
import { PIXI_CANVAS_PALETTES, type PixiCanvasPalette } from '@/composables/useThemeTokens'
import { DETAIL_BRANCH_COLOR } from '../graph/edgeStyles'

export interface PixiExecutionNode {
  id: string
  x: number
  y: number
  accent: string
  glyph: string
  title: string
  termination?: string
  foldCount?: number
  running: boolean
  detailActive: boolean
  branchAnchorKind?: 'detail' | 'continuation'
  paused: boolean
  error: boolean
  revoked: boolean
  deemphasized: boolean
  detailBranch: boolean
}

export interface PixiExecutionEdge {
  id: string
  from: { x: number; y: number }
  to: { x: number; y: number }
  color: string
  active: boolean
  phaseSeconds: number
  deemphasized: boolean
  detailBranch: boolean
  routeX?: number
}

export interface PixiExecutionScene {
  nodes: PixiExecutionNode[]
  edges: PixiExecutionEdge[]
}

interface SampledEdge extends PixiExecutionEdge {
  geometry: ExecutionEdgeGeometry
  samples: Array<{ x: number; y: number; distance: number }>
  length: number
  bounds: ExecutionWorldBounds
}

const EMPTY_SCENE: PixiExecutionScene = { nodes: [], edges: [] }
const MIN_SAMPLE_STEPS = 12
const MAX_SAMPLE_STEPS = 512
const MOTION_VIEWPORT_OVERSCAN = 120
const MOTION_SELECTION_BUCKET = 128
const MOTION_FRAME_INTERVAL = 1000 / 30
const DEFAULT_MOTION_FPS = 30
const DEEMPHASIZED_ALPHA = 0.3
const DETAIL_BRANCH_ALPHA = 0.55

function emphasisAlpha(deemphasized: boolean, detailBranch: boolean): number {
  if (!deemphasized) return 1
  return detailBranch ? DETAIL_BRANCH_ALPHA : DEEMPHASIZED_ALPHA
}

function pointOnCubic(geometry: ExecutionEdgeGeometry, t: number): { x: number; y: number } {
  const inverse = 1 - t
  const a = inverse * inverse * inverse
  const b = 3 * inverse * inverse * t
  const c = 3 * inverse * t * t
  const d = t * t * t
  return {
    x: a * geometry.from.x + b * geometry.control1.x + c * geometry.control2.x + d * geometry.to.x,
    y: a * geometry.from.y + b * geometry.control1.y + c * geometry.control2.y + d * geometry.to.y,
  }
}

function sampleEdge(edge: PixiExecutionEdge): SampledEdge {
  const geometry = executionEdgeGeometry(edge.from, edge.to, EXECUTION_ICON_RADIUS, edge.routeX)
  const controlLength =
    Math.hypot(geometry.control1.x - geometry.from.x, geometry.control1.y - geometry.from.y) +
    Math.hypot(
      geometry.control2.x - geometry.control1.x,
      geometry.control2.y - geometry.control1.y,
    ) +
    Math.hypot(geometry.to.x - geometry.control2.x, geometry.to.y - geometry.control2.y)
  const steps = Math.min(
    MAX_SAMPLE_STEPS,
    Math.max(MIN_SAMPLE_STEPS, Math.ceil(controlLength / 24)),
  )
  const samples: SampledEdge['samples'] = []
  let previous = geometry.from
  let distance = 0
  samples.push({ ...previous, distance })
  for (let index = 1; index <= steps; index += 1) {
    const point = pointOnCubic(geometry, index / steps)
    distance += Math.hypot(point.x - previous.x, point.y - previous.y)
    samples.push({ ...point, distance })
    previous = point
  }
  const points = [geometry.from, geometry.control1, geometry.control2, geometry.to]
  return {
    ...edge,
    geometry,
    samples,
    length: distance,
    bounds: {
      minX: Math.min(...points.map((point) => point.x)),
      minY: Math.min(...points.map((point) => point.y)),
      maxX: Math.max(...points.map((point) => point.x)),
      maxY: Math.max(...points.map((point) => point.y)),
    },
  }
}

function drawSampledSegment(
  graphics: Graphics,
  edge: SampledEdge,
  start: number,
  end: number,
): Graphics {
  const first = pointAtDistance(edge, start)
  graphics.moveTo(first.x, first.y)
  for (const sample of edge.samples) {
    if (sample.distance > start && sample.distance < end) graphics.lineTo(sample.x, sample.y)
  }
  const last = pointAtDistance(edge, end)
  return graphics.lineTo(last.x, last.y)
}

function pointAtDistance(edge: SampledEdge, distance: number): { x: number; y: number } {
  const bounded = Math.max(0, Math.min(edge.length, distance))
  let low = 1
  let high = edge.samples.length - 1
  while (low < high) {
    const middle = (low + high) >>> 1
    if (edge.samples[middle]!.distance < bounded) low = middle + 1
    else high = middle
  }
  const to = edge.samples[low]!
  const from = edge.samples[Math.max(0, low - 1)]!
  const span = Math.max(0.0001, to.distance - from.distance)
  const ratio = (bounded - from.distance) / span
  return {
    x: from.x + (to.x - from.x) * ratio,
    y: from.y + (to.y - from.y) * ratio,
  }
}

function drawCurve(graphics: Graphics, geometry: ExecutionEdgeGeometry): Graphics {
  return graphics
    .moveTo(geometry.from.x, geometry.from.y)
    .bezierCurveTo(
      geometry.control1.x,
      geometry.control1.y,
      geometry.control2.x,
      geometry.control2.y,
      geometry.to.x,
      geometry.to.y,
    )
}

function colorNumber(color: string): number {
  return Number.parseInt(color.replace('#', ''), 16)
}

function isElectronRuntime(): boolean {
  return /\bElectron\//.test(navigator.userAgent)
}

function rendererResolution(): number {
  const dpr = window.devicePixelRatio || 1
  // Match the backing buffer to the display on both the browser and Electron. Capping Electron at
  // 1 made Chromium upscale the whole graph on Windows display scaling, blurring node outlines and
  // every Pixi text label. A 2x ceiling keeps the fill-rate bounded on very dense displays.
  return Math.min(dpr, 2)
}

async function initializeApplication(
  host: HTMLElement,
): Promise<{ app: Application; backend: 'webgpu' | 'webgl' }> {
  const baseOptions = {
    resizeTo: host,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: rendererResolution(),
  }
  // Electron uses several simultaneous transparent/non-transparent windows. The previous GPU crash
  // was not isolated from WebGPU device creation, so retain hardware composition while using mature
  // D3D-backed WebGL for Pixi. Normal browsers can still select WebGPU.
  if (!isElectronRuntime() && 'gpu' in navigator) {
    const app = new Application()
    try {
      // 不给 WebGPU requestAdapter 传 powerPreference：Windows 上该选项被忽略（crbug 369219127）
      // 且每次初始化刷警告，去掉无行为变化。
      await app.init({ ...baseOptions, preference: 'webgpu' })
      return { app, backend: 'webgpu' }
    } catch {
      // A partially initialized WebGPU application may not have a renderer to
      // destroy. The short-lived stage has no uploaded resources at this point.
    }
  }
  const app = new Application()
  await app.init({ ...baseOptions, preference: 'webgl', powerPreference: 'high-performance' })
  return { app, backend: 'webgl' }
}

/** GPU graph surface: one static batch and one motion batch, driven by one ticker. */
export class ExecutionGraphPixiRenderer {
  private app?: Application
  private readonly world = new Container()
  private readonly staticEdges = new Graphics()
  private readonly motionEdges = new Graphics()
  private readonly staticNodes = new Graphics()
  private readonly motionNodes = new Graphics()
  private readonly labels = new Container()
  private scene = EMPTY_SCENE
  private sampledEdges: SampledEdge[] = []
  private readonly visibleMotionEdges: SampledEdge[] = []
  private readonly visibleMotionNodes: PixiExecutionNode[] = []
  private camera?: ExecutionCamera
  private motionSelectionKey = ''
  private motionPaused = false
  private suspended = false
  private reduceMotion = false
  private lastMotionDrawAt = 0
  private motionFps = DEFAULT_MOTION_FPS
  private interactionFpsTimer?: ReturnType<typeof setTimeout>
  private ticker?: () => void
  private media?: MediaQueryList
  private motionPreferenceListener?: () => void
  private visibilityListener?: () => void
  private canvasPalette: PixiCanvasPalette = PIXI_CANVAS_PALETTES.dark
  /** 标签纹理分辨率。随相机缩放逐档提升，避免放大后文字（含数字角标）糊。 */
  private labelResolution = 1
  backend: 'webgpu' | 'webgl' | 'uninitialized' = 'uninitialized'

  /** 主题切换时更新画布调色板并重画静态层。 */
  setPalette(palette: PixiCanvasPalette): void {
    if (this.canvasPalette === palette) return
    this.canvasPalette = palette
    this.drawStatic()
    this.renderWhenTickerStopped()
  }

  async mount(host: HTMLElement): Promise<void> {
    const initialized = await initializeApplication(host)
    this.app = initialized.app
    this.backend = initialized.backend
    this.app.canvas.classList.add('execution-pixi-canvas')
    this.app.canvas.setAttribute('aria-hidden', 'true')
    host.dataset.rendererBackend = this.backend
    host.replaceChildren(this.app.canvas)
    this.world.addChild(
      this.staticEdges,
      this.motionEdges,
      this.staticNodes,
      this.motionNodes,
      this.labels,
    )
    this.app.stage.addChild(this.world)
    this.media = window.matchMedia('(prefers-reduced-motion: reduce)')
    this.motionPreferenceListener = () => {
      this.reduceMotion = this.media?.matches ?? false
      if (this.reduceMotion) this.clearMotion()
      else this.lastMotionDrawAt = 0
      this.syncTickerState()
      this.renderWhenTickerStopped()
    }
    this.motionPreferenceListener()
    this.media.addEventListener('change', this.motionPreferenceListener)
    this.visibilityListener = () => this.syncTickerState()
    document.addEventListener('visibilitychange', this.visibilityListener)
    this.ticker = () => this.drawMotion(performance.now())
    this.app.ticker.maxFPS = this.motionFps
    this.app.ticker.add(this.ticker)
    this.drawStatic()
    this.syncTickerState()
  }

  /** Suspend hidden/minimized workbenches without destroying their GPU scene. */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return
    this.suspended = suspended
    this.syncTickerState()
  }

  /** Decorative motion can run slower than interaction without changing camera responsiveness. */
  setMotionFrameRate(fps: number): void {
    const next = Math.max(12, Math.min(DEFAULT_MOTION_FPS, Math.round(fps)))
    if (this.motionFps === next) return
    this.motionFps = next
    if (this.app && !this.interactionFpsTimer) this.app.ticker.maxFPS = next
  }

  /** Keep camera presentation smooth while pausing decorative motion during drag. */
  setMotionPaused(paused: boolean): void {
    if (this.motionPaused === paused) return
    this.motionPaused = paused
    if (paused) this.clearMotion()
    else this.lastMotionDrawAt = 0
    this.syncTickerState()
    this.renderWhenTickerStopped()
  }

  private syncTickerState(): void {
    if (!this.app) return
    if (this.suspended || this.motionPaused || this.reduceMotion || document.hidden) {
      this.app.ticker.stop()
    }
    else this.app.ticker.start()
  }

  /** Pixi's application ticker normally presents the stage; paused paths need one explicit frame. */
  private renderWhenTickerStopped(): void {
    if (!this.app || this.suspended || document.hidden) return
    if (this.motionPaused || this.reduceMotion) this.app.render()
  }

  setCamera(camera: ExecutionCamera): void {
    this.camera = camera
    this.world.position.set(camera.x, camera.y)
    this.world.scale.set(camera.scale)
    // 世界被 camera.scale 整体放大，标签纹理分辨率须随其提升，放大后文字才不糊。
    const needed = this.labelResolutionNeeded(camera.scale)
    if (needed !== this.labelResolution) {
      this.labelResolution = needed
      this.rebuildLabels()
    }
    this.refreshMotionItems()
    this.boostInteractionFrameRate()
    this.renderWhenTickerStopped()
  }

  /** Wheel/reset camera motion gets a short 60Hz window; idle decoration returns to 24/30Hz. */
  private boostInteractionFrameRate(): void {
    if (!this.app || this.suspended || document.hidden) return
    this.app.ticker.maxFPS = 60
    if (this.interactionFpsTimer) clearTimeout(this.interactionFpsTimer)
    this.interactionFpsTimer = setTimeout(() => {
      this.interactionFpsTimer = undefined
      if (this.app) this.app.ticker.maxFPS = this.motionFps
    }, 120)
  }

  /** 标签纹理目标分辨率：≥ 渲染器分辨率 × 相机缩放，保证放大后按 1:1 命中设备像素。 */
  private labelResolutionNeeded(scale: number): number {
    return Math.max(1, Math.ceil(rendererResolution() * scale))
  }

  /**
   * 显式重设渲染器尺寸（CSS 像素）。resizeTo 依赖 Pixi 内部 ResizeObserver，
   * 工作台最大化/窗口切换属瞬时尺寸变化，该观察者可能漏触发，导致画布位图停留在旧高度、
   * 图底部被裁剪。视口尺寸变化时由宿主显式调用，消除对 resizeTo 时序的依赖。
   */
  resize(width: number, height: number): void {
    if (!this.app || width <= 0 || height <= 0) return
    this.app.renderer.resize(width, height)
    this.renderWhenTickerStopped()
  }

  setScene(scene: PixiExecutionScene): void {
    this.scene = scene
    this.sampledEdges = scene.edges.map(sampleEdge)
    this.motionSelectionKey = ''
    this.refreshMotionItems(true)
    this.drawStatic()
    this.renderWhenTickerStopped()
  }

  private refreshMotionItems(force = false): void {
    const key = this.camera
      ? (() => {
          const bounds = cameraWorldBounds(this.camera!, MOTION_VIEWPORT_OVERSCAN)
          return [
            Math.floor(bounds.minX / MOTION_SELECTION_BUCKET),
            Math.floor(bounds.minY / MOTION_SELECTION_BUCKET),
            Math.floor(bounds.maxX / MOTION_SELECTION_BUCKET),
            Math.floor(bounds.maxY / MOTION_SELECTION_BUCKET),
          ].join(':')
        })()
      : 'all'
    if (!force && key === this.motionSelectionKey) return
    this.motionSelectionKey = key
    this.visibleMotionEdges.length = 0
    this.visibleMotionNodes.length = 0
    if (!this.camera) {
      this.visibleMotionEdges.push(...this.sampledEdges)
      this.visibleMotionNodes.push(...this.scene.nodes.filter((node) => node.running))
      return
    }
    const bounds = cameraWorldBounds(this.camera, MOTION_VIEWPORT_OVERSCAN)
    for (const edge of this.sampledEdges) {
      if (executionWorldBoundsIntersect(bounds, edge.bounds)) this.visibleMotionEdges.push(edge)
    }
    for (const node of this.scene.nodes) {
      if (
        node.running &&
        node.x >= bounds.minX &&
        node.x <= bounds.maxX &&
        node.y >= bounds.minY &&
        node.y <= bounds.maxY
      ) {
        this.visibleMotionNodes.push(node)
      }
    }
  }

  private clearMotion(): void {
    this.motionEdges.clear()
    this.motionNodes.clear()
  }

  private drawStatic(): void {
    if (!this.app) return
    this.staticEdges.clear()
    for (const edge of this.sampledEdges) {
      const color = colorNumber(edge.color)
      const alpha = emphasisAlpha(edge.deemphasized, edge.detailBranch)
      drawCurve(this.staticEdges, edge.geometry).stroke({
        color,
        width: 4.5,
        alpha: 0.07 * alpha,
      })
      drawCurve(this.staticEdges, edge.geometry).stroke({
        color,
        width: 1.35,
        alpha: (edge.active ? 0.52 : 0.38) * alpha,
      })
    }

    this.staticNodes.clear()
    const p = this.canvasPalette
    for (const node of this.scene.nodes) {
      const accent = colorNumber(node.accent)
      const alpha = emphasisAlpha(node.deemphasized, node.detailBranch)
      this.staticNodes.circle(node.x, node.y, 15).fill({ color: p.nodeFill, alpha: 0.88 * alpha })
      this.staticNodes.circle(node.x, node.y, 15).stroke({ color: accent, width: 1.4, alpha })
      this.staticNodes
        .circle(node.x, node.y, 19)
        .stroke({ color: p.ringNeutral, width: 1.5, alpha: 0.34 * alpha })
      if (node.paused || node.error || node.revoked) {
        const stateColor = node.error ? p.stateError : node.revoked ? p.stateRevoked : p.statePaused
        this.staticNodes
          .circle(node.x, node.y, 19)
          .stroke({ color: stateColor, width: 2, alpha: 0.9 * alpha })
      }
      if (node.branchAnchorKind) {
        const markerColor = colorNumber(node.branchAnchorKind === 'detail' ? '#38bdf8' : '#f59e0b')
        this.staticNodes
          .circle(node.x, node.y, 22)
          .stroke({ color: markerColor, width: 2.4, alpha: 0.95 * alpha })
      }
      if (node.detailBranch) {
        this.staticNodes.circle(node.x, node.y, 25).stroke({
          color: colorNumber(DETAIL_BRANCH_COLOR),
          width: 1.8,
          alpha: 0.82 * alpha,
        })
      }
      if (node.detailActive) {
        this.staticNodes
          .circle(node.x, node.y, 22)
          .stroke({ color: accent, width: 2.4, alpha: 0.92 * alpha })
      }
      if (node.foldCount) {
        this.staticNodes
          .circle(node.x + 12, node.y - 12, 8)
          .fill({ color: p.nodeFill, alpha: 0.95 * alpha })
        this.staticNodes
          .circle(node.x + 12, node.y - 12, 8)
          .stroke({ color: accent, width: 1, alpha })
      }
    }
    this.rebuildLabels()
  }

  /** 重建全部标签（glyph/title/termination/数字角标）。分辨率用当前档位，随相机缩放逐档重渲。 */
  private rebuildLabels(): void {
    this.labels.removeChildren().forEach((child) => child.destroy())
    const p = this.canvasPalette
    const resolution = this.labelResolution
    for (const node of this.scene.nodes) {
      const accent = colorNumber(node.accent)
      const glyph = new Text({
        text: node.glyph,
        anchor: 0.5,
        position: { x: node.x, y: node.y },
        style: {
          fill: accent,
          fontFamily: '"Segoe UI Symbol", "Noto Sans Symbols 2", system-ui, sans-serif',
          fontSize: 19,
          fontWeight: '700',
          trim: true,
        },
        resolution,
      })
      const title = new Text({
        text: node.title,
        anchor: { x: 0.5, y: 0 },
        position: { x: node.x, y: node.y + 23 },
        style: {
          fill: p.title,
          fontFamily: 'ui-monospace, monospace',
          fontSize: 10,
          fontWeight: '600',
        },
        resolution,
      })
      const alpha = emphasisAlpha(node.deemphasized, node.detailBranch)
      glyph.alpha = alpha
      title.alpha = alpha
      this.labels.addChild(glyph, title)
      if (node.termination) {
        const termination = new Text({
          text: node.termination,
          anchor: { x: 0.5, y: 0 },
          position: { x: node.x, y: node.y + 38 },
          style: { fill: p.termination, fontFamily: 'ui-monospace, monospace', fontSize: 8 },
          resolution,
        })
        termination.alpha = alpha
        this.labels.addChild(termination)
      }
      if (node.foldCount) {
        const foldCount = new Text({
          text: String(node.foldCount),
          anchor: 0.5,
          position: { x: node.x + 12, y: node.y - 12 },
          style: { fill: p.foldCount, fontFamily: 'ui-monospace, monospace', fontSize: 8 },
          resolution,
        })
        foldCount.alpha = alpha
        this.labels.addChild(foldCount)
      }
    }
  }

  private drawMotion(now: number): void {
    if (!this.app || this.reduceMotion || document.hidden) return
    if (this.suspended || this.motionPaused) return
    if (now - this.lastMotionDrawAt < MOTION_FRAME_INTERVAL) return
    this.lastMotionDrawAt = now
    const seconds = now / 1000
    this.motionEdges.clear()
    for (const edge of this.visibleMotionEdges) {
      const color = colorNumber(edge.color)
      const emphasis = emphasisAlpha(edge.deemphasized, edge.detailBranch)
      const phase =
        ((seconds - edge.phaseSeconds) * EXECUTION_EDGE_PULSE_SPEED) % EXECUTION_EDGE_PULSE_PERIOD
      for (
        let head = phase;
        head - EXECUTION_EDGE_PULSE_LENGTH < edge.length;
        head += EXECUTION_EDGE_PULSE_PERIOD
      ) {
        EXECUTION_EDGE_PULSE_SEGMENTS.forEach((segment, index) => {
          const visible = edgePulseVisibleInterval(edge.length, head, segment.length)
          if (!visible) return
          const alpha =
            [0.12, 0.16, 0.22, 0.3, 0.48, 0.3, 0.55][index]! * (edge.active ? 1.12 : 1) * emphasis
          drawSampledSegment(this.motionEdges, edge, visible.start, visible.end).stroke({
            color,
            width: 2.2,
            alpha,
          })
        })
      }
    }

    this.motionNodes.clear()
    for (const node of this.visibleMotionNodes) {
      const accent = colorNumber(node.accent)
      const emphasis = emphasisAlpha(node.deemphasized, node.detailBranch)
      const phase = ((seconds + (node.x + node.y) * 0.0007) % 1.2) / 1.2
      this.motionNodes.circle(node.x, node.y, 19 * (1 + 0.8 * phase)).stroke({
        color: accent,
        width: 3,
        alpha: 0.85 * (1 - phase) * emphasis,
      })
      const breathe = 0.3 + 0.4 * (0.5 + Math.sin((seconds * Math.PI * 2) / 0.9) * 0.5)
      this.motionNodes
        .circle(node.x + 11, node.y - 11, 3)
        .fill({ color: accent, alpha: (0.55 + breathe * 0.45) * emphasis })
    }
  }

  destroy(): void {
    if (this.interactionFpsTimer) clearTimeout(this.interactionFpsTimer)
    if (this.ticker) this.app?.ticker.remove(this.ticker)
    if (this.motionPreferenceListener) {
      this.media?.removeEventListener('change', this.motionPreferenceListener)
    }
    if (this.visibilityListener) {
      document.removeEventListener('visibilitychange', this.visibilityListener)
    }
    this.motionPreferenceListener = undefined
    this.visibilityListener = undefined
    this.media = undefined
    this.app?.destroy({ removeView: true }, { children: true })
    this.app = undefined
    this.backend = 'uninitialized'
  }
}
