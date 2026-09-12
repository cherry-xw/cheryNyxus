import { computed, nextTick, onScopeDispose, watch, type ComputedRef, type Ref } from 'vue'
import { gsap } from 'gsap'
import { useGsap } from '@/composables/useGsap'
import { useMotionTier } from '@/composables/useMotionTier'
import { MOTION } from '@/utils/gsapCore'
import type { WorkflowChangeSignal } from './useWorkflowController'
import type { WorkflowGraphProjection } from './graphModel'
import {
  planWorkflowMotion,
  pointAtPolylineProgress,
  selectWorkflowMotionLoops,
  workflowEdgePulseOpacity,
  workflowContinuousPulseTiming,
  workflowPathDurationMs,
  workflowPulseTiming,
  WorkflowMotionRegistry,
  type WorkflowMotionContext,
  type WorkflowMotionDecision,
  type WorkflowMotionEdge,
  type WorkflowMotionFrame,
  type WorkflowMotionNode,
} from './motionPolicy'

interface RuntimeMotionOptions {
  scope: Ref<HTMLElement | null>
  projection: ComputedRef<WorkflowGraphProjection>
  rootChatId: ComputedRef<string>
  timelineRevision: ComputedRef<number>
  change: Readonly<Ref<WorkflowChangeSignal>>
  replay: Readonly<Ref<boolean>>
  suspended: Readonly<Ref<boolean>>
  synced: Readonly<Ref<boolean>>
  hidden: Readonly<Ref<boolean>>
}

const MAX_ONE_SHOTS = 12
const MAX_CONTINUOUS = 8
const attr = (value: string) => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')

interface FocusPathInput {
  id: string
  points: WorkflowMotionEdge['points']
  onProgress: (point: WorkflowMotionEdge['points'][number]) => void
  onComplete?: () => void
}

export function projectWorkflowMotionFrame(
  projection: WorkflowGraphProjection,
  rootChatId: string,
): WorkflowMotionFrame {
  const nodes: WorkflowMotionNode[] = []
  for (const node of projection.nodes) {
    const data = node.data
    if (data?.kind === 'header-step') {
      const occurrence = data.slot.occurrence
      nodes.push({
        id: node.id,
        rootChatId,
        family: 'header',
        status: data.liveTurn ? 'running' : data.slot.status,
        ...(occurrence ? { occurrenceId: occurrence.occurrenceId } : {}),
        sequence: occurrence?.lastSequence ?? -1,
        live: ['running', 'waiting'].includes(data.slot.status) || !!data.liveTurn,
      })
      continue
    }
    if (data?.kind === 'content') {
      nodes.push({
        id: node.id,
        rootChatId,
        family: 'result',
        status: data.presentation.statusTone,
        sequence: data.node.orderKey ?? 0,
        live: data.presentation.statusTone === 'running',
      })
    }
  }
  const edges: WorkflowMotionEdge[] = projection.edges.map((edge) => ({
    id: edge.id,
    sourceId: edge.source,
    targetId: edge.target,
    family: edge.data?.semantic === 'fact' ? 'result' : 'header',
    points: edge.data?.points ?? [],
    evidenced: !!edge.data?.evidenced,
    sourceOccurrenceId: edge.data?.sourceOccurrenceId,
    ...(edge.data?.targetOccurrenceId ? { targetOccurrenceId: edge.data.targetOccurrenceId } : {}),
    ...(edge.data?.targetStatus ? { targetStatus: edge.data.targetStatus } : {}),
    sequence: edge.data?.targetSequence ?? 0,
  }))
  return { nodes, edges }
}

function intersects(rect: DOMRect, viewport: DOMRect): boolean {
  return (
    rect.right > viewport.left &&
    rect.left < viewport.right &&
    rect.bottom > viewport.top &&
    rect.top < viewport.bottom
  )
}

export function useRuntimeMotion(options: RuntimeMotionOptions) {
  const { spec } = useMotionTier()
  const frame = computed(() =>
    projectWorkflowMotionFrame(options.projection.value, options.rootChatId.value),
  )
  const oneShots = new WorkflowMotionRegistry()
  const continuous = new WorkflowMotionRegistry()
  const focusPaths = new WorkflowMotionRegistry()
  let context: gsap.Context | undefined
  let previousFrame = frame.value
  let previousTimelineRevision = options.timelineRevision.value
  let previousSignalSerial = options.change.value.serial
  let generation = 0
  let refreshGeneration = 0

  function motionContext(
    source: WorkflowChangeSignal['source'],
    visibleNodeIds?: ReadonlySet<string>,
  ): WorkflowMotionContext {
    const tier = spec.value
    return {
      source,
      rootChatId: options.rootChatId.value,
      synced: options.synced.value,
      replay: options.replay.value,
      suspended: options.suspended.value,
      hidden: options.hidden.value,
      spatial: tier.mode === 'full' && tier.amplitude > 0,
      loops: tier.mode === 'full' && tier.decoration !== 'off',
      visibleNodeIds,
      limit: MAX_ONE_SHOTS,
    }
  }

  function elementForNode(node: WorkflowMotionNode): HTMLElement | null {
    const root = options.scope.value
    if (!root) return null
    const name = node.family === 'header' ? 'data-workflow-step-id' : 'data-workflow-content-id'
    return root.querySelector<HTMLElement>(`[${name}="${attr(node.id)}"]`)
  }

  function track(
    key: string,
    create: (finish: () => void) => gsap.core.Animation,
    cleanup: () => void,
  ): void {
    if (!context) return
    let active = true
    let animation: gsap.core.Animation | undefined
    let release = () => {}
    const finish = () => {
      if (!active) return
      active = false
      cleanup()
      release()
    }
    release = oneShots.track(key, () => {
      animation?.kill()
      finish()
    })
    context.add(() => {
      animation = create(finish)
    })
  }

  function animateNode(decision: Extract<WorkflowMotionDecision, { kind: 'node' }>): void {
    const target = elementForNode(decision.node)
    const visual = target?.querySelector<HTMLElement>('[data-workflow-node-visual]') ?? target
    if (!target || !visual) return
    target.classList.add('is-motion-target')
    const failed =
      decision.node.status === 'failed' ||
      decision.node.status === 'danger' ||
      decision.node.status === 'rejected'
    const spatial = decision.spatial && decision.phase === 'enter'
    track(
      decision.key,
      (finish) =>
        gsap.fromTo(
          visual,
          {
            x: failed ? -5 * spec.value.amplitude : 0,
            y: spatial ? 8 * spec.value.amplitude : 0,
            scale: spatial ? 0.92 : 0.98,
            autoAlpha: 0.55,
          },
          {
            x: 0,
            y: 0,
            scale: 1,
            autoAlpha: 1,
            duration: decision.phase === 'enter' ? MOTION.view : MOTION.panel,
            ease: MOTION.easePanel,
            overwrite: true,
            onComplete: finish,
            onInterrupt: finish,
          },
        ),
      () => {
        target.classList.remove('is-motion-target')
        gsap.set(visual, { clearProps: 'transform,opacity,visibility' })
      },
    )
  }

  function animatePath(decision: Extract<WorkflowMotionDecision, { kind: 'path' }>): void {
    if (!decision.spatial) return
    const root = options.scope.value
    const runner = root?.querySelector<SVGCircleElement>(
      `[data-workflow-edge-runner="${attr(decision.edge.id)}"]`,
    )
    const signal = root?.querySelector<SVGPathElement>(
      `[data-workflow-edge-signal="${attr(decision.edge.id)}"]`,
    )
    if (!runner || !signal) return
    const progress = { value: 0 }
    const { delay, duration } = workflowPulseTiming(decision.edge, frame.value.edges)
    track(
      decision.key,
      (finish) => {
        return gsap
          .timeline({ delay, onComplete: finish, onInterrupt: finish })
          .set(runner, { autoAlpha: 1, immediateRender: false }, 0)
          .fromTo(
            signal,
            { strokeDashoffset: 100, autoAlpha: 0.9 },
            {
              strokeDashoffset: 0,
              autoAlpha: 0.9,
              duration,
              ease: 'power1.inOut',
              immediateRender: false,
            },
            0,
          )
          .to(
            progress,
            {
              value: 1,
              duration,
              ease: 'power1.inOut',
              onUpdate: () => {
                const point = pointAtPolylineProgress(decision.edge.points, progress.value)
                runner.setAttribute('transform', `translate(${point.x} ${point.y})`)
              },
            },
            0,
          )
          .to(
            runner,
            { autoAlpha: 0, duration: MOTION.control },
            Math.max(0, duration - MOTION.control),
          )
      },
      () => {
        gsap.set([runner, signal], { clearProps: 'opacity,visibility,strokeDashoffset' })
      },
    )
  }

  function animateResultEdge(
    decision: Extract<WorkflowMotionDecision, { kind: 'result-edge' }>,
  ): void {
    const signal = options.scope.value?.querySelector<SVGPathElement>(
      `[data-workflow-result-edge="${attr(decision.edge.id)}"]`,
    )
    if (!signal) return
    track(
      decision.key,
      (finish) =>
        gsap.fromTo(
          signal,
          { strokeDashoffset: 42, autoAlpha: 0.85 },
          {
            strokeDashoffset: 0,
            autoAlpha: 0,
            duration: MOTION.sweep,
            ease: MOTION.easePanel,
            overwrite: true,
            onComplete: finish,
            onInterrupt: finish,
          },
        ),
      () => {
        gsap.set(signal, { clearProps: 'opacity,visibility,strokeDashoffset' })
      },
    )
  }

  function runOneShots(
    before: WorkflowMotionFrame,
    next: WorkflowMotionFrame,
    token: number,
  ): void {
    if (token !== generation || !context) return
    const root = options.scope.value
    if (!root) return
    const viewport = root.getBoundingClientRect()
    const visible = new Set(
      next.nodes
        .filter((node) => {
          const element = elementForNode(node)
          return element ? intersects(element.getBoundingClientRect(), viewport) : false
        })
        .map((node) => node.id),
    )
    for (const decision of planWorkflowMotion(before, next, motionContext('live', visible))) {
      if (decision.kind === 'node') animateNode(decision)
      else if (decision.kind === 'path') animatePath(decision)
      else animateResultEdge(decision)
    }
    scheduleContinuousRefresh()
  }

  function loopKey(node: WorkflowMotionNode): string {
    return JSON.stringify([node.id, node.occurrenceId, node.status])
  }

  function startContinuous(node: WorkflowMotionNode): void {
    const target = elementForNode(node)
    const visual = target?.querySelector<HTMLElement>('[data-workflow-node-visual]')
    const beacon = target?.querySelector<HTMLElement>('[data-workflow-beacon]')
    const loading = target?.querySelector<HTMLElement>('[data-workflow-loading]')
    const key = loopKey(node)
    if (!visual || continuous.keys().includes(key) || !context) return
    let animation: gsap.core.Timeline | undefined
    continuous.track(key, () => {
      animation?.kill()
      gsap.set([visual, ...(loading ? [loading] : []), ...(beacon ? [beacon] : [])], {
        clearProps: 'transform,opacity,visibility',
      })
    })
    context.add(() => {
      animation = gsap.timeline()
      if (loading)
        animation.to(loading, { rotation: 360, duration: 0.9, repeat: -1, ease: 'none' }, 0)
      if (beacon) animation.fromTo(beacon,
        { scale: 1, opacity: 0.9 },
        { scale: 1.1, opacity: 0.12, duration: 0.8, repeat: -1, yoyo: true, ease: 'sine.inOut' }, 0)

    })
  }

  function edgeLoopKey(edge: WorkflowMotionEdge): string {
    return JSON.stringify([
      'edge',
      edge.id,
      edge.targetStatus,
      edge.points,
      workflowContinuousPulseTiming(edge, frame.value.edges),
    ])
  }

  function startEdgeLoop(edge: WorkflowMotionEdge): void {
    const key = edgeLoopKey(edge)
    const signal = options.scope.value?.querySelector<SVGPathElement>(
      `[data-workflow-edge-loop="${attr(edge.id)}"]`,
    )
    if (!signal || !context || continuous.keys().includes(key)) return
    let animation: gsap.core.Timeline | undefined
    continuous.track(key, () => {
      animation?.kill()
      gsap.set(signal, { clearProps: 'opacity,visibility,strokeDashoffset' })
    })
    context.add(() => {
      const { delay, duration, cycle } = workflowContinuousPulseTiming(edge, frame.value.edges)
      animation = gsap
        .timeline({ repeat: -1, repeatDelay: 0.35 })
        .set(signal, { autoAlpha: 0 }, 0)
        .fromTo(
          signal,
          { strokeDashoffset: 100, autoAlpha: workflowEdgePulseOpacity(edge) },
          {
            strokeDashoffset: 0,
            autoAlpha: workflowEdgePulseOpacity(edge),
            duration,
            ease: 'none',
            immediateRender: false,
          },
          delay,
        )
        .set(signal, { autoAlpha: 0 }, delay + duration)
        .set(signal, { autoAlpha: 0 }, cycle)
    })
  }

  function syncContinuous(): void {
    const root = options.scope.value
    const current = motionContext('live')
    if (
      !root ||
      !current.loops ||
      !current.synced ||
      current.replay ||
      current.suspended ||
      current.hidden
    ) {
      continuous.cancelAll()
      return
    }
    const viewport = root.getBoundingClientRect()
    const visible = new Set(
      frame.value.nodes
        .filter((node) => {
          const element = elementForNode(node)
          return element ? intersects(element.getBoundingClientRect(), viewport) : false
        })
        .map((node) => node.id),
    )
    const active = selectWorkflowMotionLoops(
      frame.value,
      { ...current, visibleNodeIds: visible },
      MAX_CONTINUOUS,
    )
    const visibleEdges = frame.value.edges.filter((edge) => {
      if (!workflowEdgePulseOpacity(edge)) return false
      const path = root.querySelector<SVGPathElement>(
        `[data-workflow-edge-loop="${attr(edge.id)}"]`,
      )
      return !!path && intersects(path.getBoundingClientRect(), viewport)
    })
    const desired = new Set([...active.map(loopKey), ...visibleEdges.map(edgeLoopKey)])
    for (const key of continuous.keys()) if (!desired.has(key)) continuous.cancel(key)
    for (const node of active) startContinuous(node)
    for (const edge of visibleEdges) startEdgeLoop(edge)
  }

  function scheduleContinuousRefresh(): void {
    const token = ++refreshGeneration
    void nextTick(() => {
      if (token === refreshGeneration) syncContinuous()
    })
  }

  function cancelFocusMotion(): void {
    focusPaths.cancelAll()
  }

  function focusAlongPath(input: FocusPathInput): void {
    cancelFocusMotion()
    const finishAtTarget = () => {
      const target = input.points.at(-1)
      if (target) input.onProgress(target)
      input.onComplete?.()
    }
    const tier = spec.value
    if (
      tier.mode !== 'full' ||
      tier.amplitude <= 0 ||
      options.replay.value ||
      options.suspended.value ||
      options.hidden.value ||
      !options.synced.value ||
      input.points.length < 2
    ) {
      finishAtTarget()
      return
    }
    const runner = options.scope.value?.querySelector<SVGCircleElement>(
      `[data-workflow-focus-runner="${attr(input.id)}"]`,
    )
    if (!runner || !context) {
      finishAtTarget()
      return
    }
    const progress = { value: 0 }
    let animation: gsap.core.Tween | undefined
    let release = () => {}
    let completed = false
    const cleanup = () => {
      animation?.kill()
      gsap.set(runner, { clearProps: 'opacity,visibility,transform' })
      release()
    }
    const complete = () => {
      if (completed) return
      completed = true
      finishAtTarget()
      cleanup()
    }
    release = focusPaths.track(input.id, cleanup)
    context.add(() => {
      gsap.set(runner, { autoAlpha: 1 })
      animation = gsap.to(progress, {
        value: 1,
        duration: workflowPathDurationMs(input.points) / 1000,
        ease: 'power1.inOut',
        overwrite: true,
        onUpdate: () => {
          const point = pointAtPolylineProgress(input.points, progress.value)
          runner.setAttribute('transform', `translate(${point.x} ${point.y})`)
          input.onProgress(point)
        },
        onComplete: complete,
      })
    })
  }

  watch(
    [frame, options.timelineRevision, options.change],
    ([next]) => {
      const before = previousFrame
      previousFrame = next
      const revision = options.timelineRevision.value
      const signal = options.change.value
      const liveWorkflow = signal.serial > previousSignalSerial && signal.source === 'live'
      const liveTimeline = previousTimelineRevision > 0 && revision > previousTimelineRevision
      previousSignalSerial = signal.serial
      previousTimelineRevision = revision
      const token = ++generation
      if (liveWorkflow || liveTimeline) void nextTick(() => runOneShots(before, next, token))
      else if (signal.source !== 'live') oneShots.cancelAll()
      scheduleContinuousRefresh()
    },
    { flush: 'post' },
  )

  watch(
    [options.rootChatId, options.replay, options.suspended, options.synced, options.hidden, spec],
    () => {
      ++generation
      oneShots.cancelAll()
      continuous.cancelAll()
      cancelFocusMotion()
      scheduleContinuousRefresh()
    },
    { flush: 'post' },
  )

  useGsap(options.scope, (gsapContext) => {
    context = gsapContext
    scheduleContinuousRefresh()
  })
  onScopeDispose(() => {
    ++generation
    ++refreshGeneration
    oneShots.cancelAll()
    continuous.cancelAll()
    cancelFocusMotion()
    context = undefined
  })
  return {
    refreshVisibility: scheduleContinuousRefresh,
    focusAlongPath,
    cancelFocusMotion,
    cancelMotion: () => {
      oneShots.cancelAll()
      continuous.cancelAll()
      cancelFocusMotion()
    },
  }
}
