import { computed, nextTick, onScopeDispose, watch, type ComputedRef, type Ref } from 'vue'
import { gsap } from 'gsap'
import { useGsap } from '@/composables/useGsap'
import { useMotionTier } from '@/composables/useMotionTier'
import { absoluteGraphPosition } from './headerGraph'
import type { WorkflowGraphNode, WorkflowGraphProjection } from './graphModel'
import type { HeaderPoint } from './headerTemplate'

interface LayoutMotionOptions {
  host: Ref<HTMLElement | null>
  projection: ComputedRef<WorkflowGraphProjection>
  root: ComputedRef<string>
  disabled: ComputedRef<boolean>
}
interface Pose extends HeaderPoint {
  opacity: number
  scale: number
}
interface Visual {
  id: string
  element: HTMLElement
  pose: Pose
  origin: HeaderPoint
  width: number
  height: number
}
const isHeaderNode = (node: WorkflowGraphNode) =>
  ['header', 'header-group', 'header-step', 'header-terminal'].includes(
    node.data?.kind ?? '',
  )
/** Only geometry changes trigger layout motion; content and status deltas do not. */
export function headerGeometryKey(projection: WorkflowGraphProjection): string {
  return projection.nodes
    .filter(isHeaderNode)
    .map((n) => `${n.id}:${n.position.x},${n.position.y},${n.width},${n.height}`)
    .join('|')
}
export function useHeaderLayoutMotion(options: LayoutMotionOptions): void {
  const { spec } = useMotionTier()
  let context: gsap.Context | undefined, tween: gsap.core.Tween | undefined
  let serial = 0
  let visuals = new Map<string, Visual>()
  const hidden = new Map<Element, string>()
  const overlays: Element[] = []
  const signature = computed(() => headerGeometryKey(options.projection.value))
  let previous = options.projection.value
  function cleanup(): void {
    tween?.kill()
    tween = undefined
    for (const [element, opacity] of hidden) (element as HTMLElement).style.opacity = opacity
    hidden.clear()
    for (const element of overlays) element.remove()
    overlays.length = 0
    visuals.clear()
  }
  function cancel(): void {
    ++serial
    cleanup()
  }
  function nodeElements(): Map<string, HTMLElement> {
    return new Map(
      Array.from(options.host.value?.querySelectorAll<HTMLElement>('.vue-flow__node') ?? []).map(
        (element) => [element.dataset.id ?? '', element],
      ),
    )
  }
  function clone(
    element: HTMLElement,
    node: WorkflowGraphNode,
    projection: WorkflowGraphProjection,
    pose?: Pose,
  ): Visual {
    const root = element.parentElement!
    const copy = element.cloneNode(true) as HTMLElement
    copy.removeAttribute('data-id')
    copy.removeAttribute('id')
    copy.setAttribute('aria-hidden', 'true')
    copy.setAttribute('inert', '')
    for (const child of copy.querySelectorAll('[id]')) child.removeAttribute('id')
    copy.classList.remove('vue-flow__node')
    copy.style.pointerEvents = 'none'
    copy.style.position = 'absolute'
    copy.style.margin = '0'
    copy.style.transformOrigin = '0 0'
    copy.style.width = `${Number(node.width)}px`
    copy.style.height = `${Number(node.height)}px`
    const origin = absoluteGraphPosition(node, projection.nodes)
    const visual = {
      id: node.id,
      element: copy,
      origin,
      width: Number(node.width),
      height: Number(node.height),
      pose: pose ?? { ...origin, opacity: 1, scale: 1 },
    }
    root.append(copy)
    overlays.push(copy)
    return visual
  }
  function hide(element: Element): void {
    if (!hidden.has(element)) hidden.set(element, (element as HTMLElement).style.opacity)
    ;(element as HTMLElement).style.opacity = '0'
  }
  function representative(
    node: WorkflowGraphNode,
    target: WorkflowGraphProjection,
  ): WorkflowGraphNode | undefined {
    const id = target.representatives?.[node.id]
    let found = id ? target.nodes.find((n) => n.id === id) : undefined
    let parentId = node.parentNode
    while (!found && parentId) {
      found = target.nodes.find((n) => n.id === parentId)
      parentId = previous.nodes.find((n) => n.id === parentId)?.parentNode
    }
    return found ?? target.nodes.find((n) => n.id === target.activeHeaderId)
  }
  watch(
    signature,
    () => {
      const before = previous,
        after = options.projection.value
      previous = after
      const token = ++serial
      if (options.disabled.value || !context || !options.host.value) {
        cleanup()
        return
      }
      const currentPoses = new Map(
        [...visuals].map(([id, v]) => [id.startsWith('new:') ? id.slice(4) : id, { ...v.pose }]),
      )
      cleanup()
      const oldElements = nodeElements()
      const oldClones = new Map<string, Visual>()
      for (const node of before.nodes.filter(isHeaderNode)) {
        const element = oldElements.get(node.id)
        if (!element) continue
        const visual = clone(element, node, before, currentPoses.get(node.id))
        oldClones.set(node.id, visual)
      }
      void nextTick(() => {
        if (token !== serial || !context) return
        const elements = nodeElements()
        const destinations = new Map<string, Pose>()
        const spatial = spec.value.mode === 'full' && spec.value.amplitude > 0
        visuals = oldClones
        for (const [id, visual] of visuals) {
          const oldNode = before.nodes.find((n) => n.id === id)!
          const current = after.nodes.find((n) => n.id === id)
          const targetNode = current ?? representative(oldNode, after)
          const target = targetNode ? absoluteGraphPosition(targetNode, after.nodes) : visual.origin
          destinations.set(id, {
            x: spatial ? target.x : visual.pose.x,
            y: spatial ? target.y : visual.pose.y,
            opacity: 0,
            scale: spatial && !current ? 0.15 : 1,
          })
        }
        const newVisuals = new Map<string, Visual>()
        for (const node of after.nodes.filter(isHeaderNode)) {
          const element = elements.get(node.id)
          if (!element) continue
          hide(element)
          const final = absoluteGraphPosition(node, after.nodes)
          const old = visuals.get(node.id)
          const ancestor = representative(node, before)
          const origin = ancestor ? absoluteGraphPosition(ancestor, before.nodes) : final
          const initial = old?.pose ?? { ...origin, opacity: 0, scale: spatial ? 0.15 : 1 }
          const v = clone(element, node, after, {
            x: spatial ? initial.x : final.x,
            y: spatial ? initial.y : final.y,
            opacity: 0,
            scale: spatial ? initial.scale : 1,
          })
          newVisuals.set(node.id, v)
          destinations.set(`new:${node.id}`, { ...final, opacity: 1, scale: 1 })
        }
        // Only settled board routes are visible. Interpolating unrelated old/new nets
        // would create transient crossings even when both layouts are planar.
        for (const element of options.host.value?.querySelectorAll(
          '[data-workflow-layout-edge], .workflow-header-edge-label',
        ) ?? [])
          hide(element)
        const starts = new Map<string, Pose>()
        for (const [id, visual] of visuals) starts.set(id, { ...visual.pose })
        for (const [id, visual] of newVisuals) {
          visuals.set(`new:${id}`, visual)
          starts.set(`new:${id}`, { ...visual.pose })
        }
        const progress = { value: 0 }
        const update = () => {
          for (const [id, visual] of visuals) {
            const a = starts.get(id)!,
              b = destinations.get(id)!,
              p = progress.value
            visual.pose = {
              x: a.x + (b.x - a.x) * p,
              y: a.y + (b.y - a.y) * p,
              scale: a.scale + (b.scale - a.scale) * p,
              opacity: a.opacity + (b.opacity - a.opacity) * p,
            }
            visual.element.style.transform = `translate(${visual.pose.x}px, ${visual.pose.y}px) scale(${visual.pose.scale})`
            visual.element.style.opacity = String(visual.pose.opacity)
          }
        }
        context.add(() => {
          update()
          tween = gsap.to(progress, {
            value: 1,
            duration: spatial ? 0.28 : 0.1,
            ease: 'power2.out',
            onUpdate: update,
            onComplete: cleanup,
          })
        })
      })
    },
    { flush: 'pre' },
  )
  watch([options.root, options.disabled, spec], cancel, { flush: 'sync' })
  useGsap(options.host, (value) => {
    context = value
  })
  onScopeDispose(() => {
    cancel()
    context = undefined
  })
}
