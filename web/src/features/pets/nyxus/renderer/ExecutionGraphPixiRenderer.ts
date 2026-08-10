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
  paused: boolean
  error: boolean
  revoked: boolean
}

export interface PixiExecutionEdge {
  id: string
  from: { x: number; y: number }
  to: { x: number; y: number }
  color: string
  active: boolean
  phaseSeconds: number
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
  const geometry = executionEdgeGeometry(edge.from, edge.to, EXECUTION_ICON_RADIUS)
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

async function initializeApplication(
  host: HTMLElement,
): Promise<{ app: Application; backend: 'webgpu' | 'webgl' }> {
  const baseOptions = {
    resizeTo: host,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
  }
  if ('gpu' in navigator) {
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
  private reduceMotion = false
  private ticker?: () => void
  private media?: MediaQueryList
  private motionPreferenceListener?: () => void
  backend: 'webgpu' | 'webgl' | 'uninitialized' = 'uninitialized'

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
    const updateMotionPreference = () => {
      this.reduceMotion = this.media?.matches ?? false
      if (this.reduceMotion) this.clearMotion()
    }
    this.motionPreferenceListener = updateMotionPreference
    updateMotionPreference()
    this.media.addEventListener('change', updateMotionPreference)
    this.ticker = () => this.drawMotion(performance.now())
    this.app.ticker.add(this.ticker)
    this.drawStatic()
  }

  setCamera(camera: ExecutionCamera): void {
    this.camera = camera
    this.world.position.set(camera.x, camera.y)
    this.world.scale.set(camera.scale)
    this.refreshMotionItems()
  }

  /**
   * 显式重设渲染器尺寸（CSS 像素）。resizeTo 依赖 Pixi 内部 ResizeObserver，
   * 工作台最大化/窗口切换属瞬时尺寸变化，该观察者可能漏触发，导致画布位图停留在旧高度、
   * 图底部被裁剪。视口尺寸变化时由宿主显式调用，消除对 resizeTo 时序的依赖。
   */
  resize(width: number, height: number): void {
    if (!this.app || width <= 0 || height <= 0) return
    this.app.renderer.resize(width, height)
  }

  setScene(scene: PixiExecutionScene): void {
    this.scene = scene
    this.sampledEdges = scene.edges.map(sampleEdge)
    this.refreshMotionItems()
    this.drawStatic()
  }

  private refreshMotionItems(): void {
    this.visibleMotionEdges.length = 0
    this.visibleMotionNodes.length = 0
    if (!this.camera) {
      this.visibleMotionEdges.push(...this.sampledEdges)
      this.visibleMotionNodes.push(...this.scene.nodes)
      return
    }
    const bounds = cameraWorldBounds(this.camera, MOTION_VIEWPORT_OVERSCAN)
    for (const edge of this.sampledEdges) {
      if (executionWorldBoundsIntersect(bounds, edge.bounds)) this.visibleMotionEdges.push(edge)
    }
    for (const node of this.scene.nodes) {
      if (
        node.x >= bounds.minX &&
        node.x <= bounds.maxX &&
        node.y >= bounds.minY &&
        node.y <= bounds.maxY
      ) {
        this.visibleMotionNodes.push(node)
      }
    }
  }

  private drawStatic(): void {
    if (!this.app) return
    this.staticEdges.clear()
    for (const edge of this.sampledEdges) {
      const color = colorNumber(edge.color)
      drawCurve(this.staticEdges, edge.geometry).stroke({ color, width: 4.5, alpha: 0.07 })
      drawCurve(this.staticEdges, edge.geometry).stroke({
        color,
        width: 1.35,
        alpha: edge.active ? 0.52 : 0.38,
      })
    }

    this.staticNodes.clear()
    this.labels.removeChildren().forEach((child) => child.destroy())
    for (const node of this.scene.nodes) {
      const accent = colorNumber(node.accent)
      this.staticNodes.circle(node.x, node.y, 15).fill({ color: 0x081925, alpha: 0.88 })
      this.staticNodes.circle(node.x, node.y, 15).stroke({ color: accent, width: 1.4, alpha: 1 })
      this.staticNodes
        .circle(node.x, node.y, 19)
        .stroke({ color: 0x7a5cff, width: 1.5, alpha: 0.34 })
      if (node.paused || node.error || node.revoked) {
        const stateColor = node.error ? 0xff718c : node.revoked ? 0x8b8f99 : 0xf6c85f
        this.staticNodes
          .circle(node.x, node.y, 19)
          .stroke({ color: stateColor, width: 2, alpha: 0.9 })
      }
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
        resolution: 1,
      })
      const title = new Text({
        text: node.title,
        anchor: { x: 0.5, y: 0 },
        position: { x: node.x, y: node.y + 23 },
        style: {
          fill: 0xdce9ff,
          fontFamily: 'ui-monospace, monospace',
          fontSize: 10,
          fontWeight: '600',
        },
        resolution: 1,
      })
      this.labels.addChild(glyph, title)
      if (node.termination) {
        this.labels.addChild(
          new Text({
            text: node.termination,
            anchor: { x: 0.5, y: 0 },
            position: { x: node.x, y: node.y + 38 },
            style: { fill: 0xffb6c4, fontFamily: 'ui-monospace, monospace', fontSize: 8 },
            resolution: 1,
          }),
        )
      }
      if (node.foldCount) {
        this.staticNodes.circle(node.x + 12, node.y - 12, 8).fill({ color: 0x081925, alpha: 0.95 })
        this.staticNodes
          .circle(node.x + 12, node.y - 12, 8)
          .stroke({ color: accent, width: 1, alpha: 1 })
        this.labels.addChild(
          new Text({
            text: String(node.foldCount),
            anchor: 0.5,
            position: { x: node.x + 12, y: node.y - 12 },
            style: { fill: 0xffffff, fontFamily: 'ui-monospace, monospace', fontSize: 8 },
            resolution: 1,
          }),
        )
      }
    }
  }

  private clearMotion(): void {
    this.motionEdges.clear()
    this.motionNodes.clear()
  }

  private drawMotion(now: number): void {
    if (!this.app || this.reduceMotion || document.hidden) return
    const seconds = now / 1000
    this.motionEdges.clear()
    for (const edge of this.visibleMotionEdges) {
      const color = colorNumber(edge.color)
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
          const alpha = [0.12, 0.16, 0.22, 0.3, 0.48, 0.3, 0.55][index]! * (edge.active ? 1.12 : 1)
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
      const duration = node.detailActive ? 1.05 : node.running ? 1.2 : 1.8
      const phase = ((seconds + (node.x + node.y) * 0.0007) % duration) / duration
      const maxScale = node.detailActive ? 1.9 : node.running ? 1.8 : 1.7
      const opacity = (node.detailActive ? 0.92 : node.running ? 0.85 : 0.35) * (1 - phase)
      this.motionNodes.circle(node.x, node.y, 19 * (1 + (maxScale - 1) * phase)).stroke({
        color: accent,
        width: node.running || node.detailActive ? 3 : 2,
        alpha: opacity,
      })
      if (node.detailActive) {
        const secondPhase = (phase + 0.5) % 1
        this.motionNodes.circle(node.x, node.y, 19 * (1 + 0.9 * secondPhase)).stroke({
          color: accent,
          width: 3,
          alpha: 0.92 * (1 - secondPhase),
        })
      }
      if (node.running) {
        const breathe = 0.3 + 0.4 * (0.5 + Math.sin((seconds * Math.PI * 2) / 0.9) * 0.5)
        this.motionNodes
          .circle(node.x, node.y, 18 + breathe * 5)
          .stroke({ color: accent, width: 6, alpha: breathe * 0.45 })
        this.motionNodes
          .circle(node.x + 11, node.y - 11, 3)
          .fill({ color: accent, alpha: 0.55 + breathe * 0.45 })
      }
    }
  }

  destroy(): void {
    if (this.ticker) this.app?.ticker.remove(this.ticker)
    if (this.motionPreferenceListener) {
      this.media?.removeEventListener('change', this.motionPreferenceListener)
    }
    this.motionPreferenceListener = undefined
    this.media = undefined
    this.app?.destroy({ removeView: true }, { children: true })
    this.app = undefined
    this.backend = 'uninitialized'
  }
}
