import { computed, nextTick, onScopeDispose, watch, type ComputedRef, type Ref } from 'vue'
import { gsap } from 'gsap'
import { useGsap } from '@/composables/useGsap'
import { useMotionTier } from '@/composables/useMotionTier'
import { MOTION } from '@/utils/gsapCore'
import type { WorkflowChangeSignal } from './useWorkflowController'
import type { WorkflowGraphProjection } from './graphModel'
import {
  planWorkflowMotion,
  selectWorkflowMotionLoops,
  WorkflowMotionRegistry,
  type WorkflowMotionContext,
  type WorkflowMotionDecision,
  type WorkflowMotionItem,
} from './motionPolicy'

interface RuntimeMotionOptions {
  scope: Ref<HTMLElement | null>
  projection: ComputedRef<WorkflowGraphProjection>
  rootChatId: ComputedRef<string>
  change: Readonly<Ref<WorkflowChangeSignal>>
  replay: Readonly<Ref<boolean>>
  suspended: Readonly<Ref<boolean>>
  synced: Readonly<Ref<boolean>>
  hidden: Readonly<Ref<boolean>>
}

interface MeasuredOccurrence {
  target: HTMLElement
  targetRect: DOMRect
  source?: HTMLElement
  sourceRect?: DOMRect
}

const MAX_ONE_SHOTS = 12
const MAX_CONTINUOUS = 8

function motionItems(projection: WorkflowGraphProjection): WorkflowMotionItem[] {
  return projection.nodes.flatMap((node) => {
    const data = node.data
    if (data?.kind !== 'occurrence') return []
    const occurrence = data.occurrence
    return [
      {
        occurrenceId: occurrence.occurrenceId,
        rootChatId: occurrence.rootChatId,
        sourceHeaderId: data.sourceHeaderId,
        kind: occurrence.kind,
        status: occurrence.status,
        live: data.live,
        orderQuality: occurrence.orderQuality,
        firstSequence: occurrence.firstSequence,
        lastSequence: occurrence.lastSequence,
      },
    ]
  })
}

function intersects(rect: DOMRect, viewport: DOMRect): boolean {
  return (
    rect.right > viewport.left &&
    rect.left < viewport.right &&
    rect.bottom > viewport.top &&
    rect.top < viewport.bottom
  )
}

function centerDelta(source: DOMRect, target: DOMRect, amplitude: number) {
  return {
    x: (source.left + source.width / 2 - target.left - target.width / 2) * amplitude,
    y: (source.top + source.height / 2 - target.top - target.height / 2) * amplitude,
  }
}

export function useRuntimeMotion(options: RuntimeMotionOptions) {
  const { spec } = useMotionTier()
  const frame = computed(() => motionItems(options.projection.value))
  const oneShots = new WorkflowMotionRegistry()
  const continuous = new WorkflowMotionRegistry()
  const loopSignatures = new Map<string, string>()
  let context: gsap.Context | undefined
  let previousFrame = frame.value
  let signaledFrame: readonly WorkflowMotionItem[] | undefined
  let animationGeneration = 0
  let refreshGeneration = 0

  function motionContext(
    source: WorkflowChangeSignal['source'],
    visibleOccurrenceIds?: ReadonlySet<string>,
    limit = MAX_ONE_SHOTS,
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
      visibleOccurrenceIds,
      limit,
    }
  }

  function clearElementMotion(element: HTMLElement): void {
    element.classList.remove('is-motion-target')
    element.style.removeProperty('transform')
    element.style.removeProperty('opacity')
    element.style.removeProperty('visibility')
  }

  function trackTween(
    key: string,
    target: HTMLElement,
    create: (finish: () => void) => gsap.core.Tween,
    ghost?: HTMLElement,
  ): void {
    if (!context) return
    let active = true
    let tween: gsap.core.Tween | undefined
    let release = () => {}
    const finish = () => {
      if (!active) return
      active = false
      ghost?.remove()
      clearElementMotion(target)
      release()
    }
    const cancel = () => {
      if (!active) return
      tween?.kill()
      finish()
    }
    release = oneShots.track(key, cancel)
    target.classList.add('is-motion-target')
    context.add(() => {
      tween = create(finish)
    })
  }

  function animateGhost(
    decision: WorkflowMotionDecision,
    measured: MeasuredOccurrence,
    viewport: DOMRect,
  ): boolean {
    const root = options.scope.value
    const sourceRect = measured.sourceRect
    if (!root || !sourceRect || !intersects(sourceRect, viewport)) return false
    const target = measured.target
    const targetRect = measured.targetRect
    const delta = centerDelta(sourceRect, targetRect, spec.value.amplitude)
    const ghost = target.cloneNode(true) as HTMLButtonElement
    ghost.classList.add('workflow-motion-ghost')
    ghost.classList.remove('is-live')
    ghost.removeAttribute('data-workflow-occurrence-id')
    ghost.setAttribute('aria-hidden', 'true')
    ghost.tabIndex = -1
    ghost.disabled = true
    Object.assign(ghost.style, {
      left: `${targetRect.left - viewport.left}px`,
      top: `${targetRect.top - viewport.top}px`,
      width: `${targetRect.width}px`,
      height: `${targetRect.height}px`,
    })
    root.append(ghost)
    trackTween(
      decision.item.occurrenceId,
      target,
      (finish) => {
        gsap.set(target, { autoAlpha: 0 })
        return gsap.fromTo(
          ghost,
          { x: delta.x, y: delta.y, scale: 0.88, autoAlpha: 0.62 },
          {
            x: 0,
            y: 0,
            scale: 1,
            autoAlpha: 1,
            duration: MOTION.sweep,
            ease: MOTION.easePanel,
            overwrite: true,
            onComplete: finish,
            onInterrupt: finish,
          },
        )
      },
      ghost,
    )
    return true
  }

  function animateNode(decision: WorkflowMotionDecision, measured: MeasuredOccurrence): void {
    const target = measured.target
    const sourceRect = measured.sourceRect
    const targetRect = measured.targetRect
    const amplitude = spec.value.amplitude
    const delta =
      decision.phase === 'enter' && decision.spatial && sourceRect
        ? centerDelta(sourceRect, targetRect, amplitude)
        : { x: decision.item.status === 'failed' ? -4 * amplitude : 0, y: 0 }
    const spatialScale = decision.spatial ? (decision.phase === 'enter' ? 0.9 : 0.97) : 1
    trackTween(decision.item.occurrenceId, target, (finish) =>
      gsap.fromTo(
        target,
        {
          x: delta.x,
          y: delta.y,
          scale: spatialScale,
          autoAlpha: decision.phase === 'enter' ? 0.42 : 0.68,
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
    )
  }

  function headerSource(item: WorkflowMotionItem, headers: Map<string, HTMLElement>) {
    const header = headers.get(item.sourceHeaderId)
    if (!header) return undefined
    return (
      [...header.querySelectorAll<HTMLElement>('[data-workflow-slot-kind]')].find(
        (slot) => slot.dataset.workflowSlotKind === item.kind,
      ) ?? header
    )
  }

  function measure(
    candidates: readonly WorkflowMotionDecision[],
  ):
    | { viewport: DOMRect; values: Map<string, MeasuredOccurrence>; visible: Set<string> }
    | undefined {
    const root = options.scope.value
    if (!root) return undefined
    const viewport = root.getBoundingClientRect()
    const targets = new Map(
      [...root.querySelectorAll<HTMLElement>('[data-workflow-occurrence-id]')].map((element) => [
        element.dataset.workflowOccurrenceId!,
        element,
      ]),
    )
    const headers = new Map(
      [...root.querySelectorAll<HTMLElement>('[data-workflow-header-id]')].map((element) => [
        element.dataset.workflowHeaderId!,
        element,
      ]),
    )
    const values = new Map<string, MeasuredOccurrence>()
    const visible = new Set<string>()
    for (const decision of candidates) {
      const target = targets.get(decision.item.occurrenceId)
      if (!target) continue
      const source = headerSource(decision.item, headers)
      const targetRect = target.getBoundingClientRect()
      const sourceRect = source?.getBoundingClientRect()
      values.set(decision.item.occurrenceId, { target, targetRect, source, sourceRect })
      if (intersects(targetRect, viewport)) visible.add(decision.item.occurrenceId)
    }
    return { viewport, values, visible }
  }

  function runOneShots(
    before: readonly WorkflowMotionItem[],
    next: readonly WorkflowMotionItem[],
    source: WorkflowChangeSignal['source'],
    token: number,
  ): void {
    if (token !== animationGeneration || !context) return
    const candidates = planWorkflowMotion(
      before,
      next,
      motionContext(source, undefined, next.length),
    )
    for (const decision of candidates) {
      if (decision.phase === 'settle') {
        continuous.cancel(decision.item.occurrenceId)
        loopSignatures.delete(decision.item.occurrenceId)
      }
    }
    const measured = measure(candidates)
    if (!measured) return
    const decisions = planWorkflowMotion(
      before,
      next,
      motionContext(source, measured.visible, MAX_ONE_SHOTS),
    )
    for (const decision of decisions) {
      const value = measured.values.get(decision.item.occurrenceId)
      if (!value) continue
      if (
        decision.phase === 'settle' &&
        decision.spatial &&
        animateGhost(decision, value, measured.viewport)
      )
        continue
      animateNode(decision, value)
    }
    scheduleContinuousRefresh()
  }

  function startLoop(item: WorkflowMotionItem, icon: HTMLElement): void {
    if (!context) return
    const signature = `${item.status}:${icon.dataset.workflowStateIcon ?? ''}`
    if (loopSignatures.get(item.occurrenceId) === signature) return
    continuous.cancel(item.occurrenceId)
    loopSignatures.delete(item.occurrenceId)
    let active = true
    let tween: gsap.core.Tween | undefined
    let release = () => {}
    const finish = () => {
      if (!active) return
      active = false
      icon.classList.remove('is-motion-looping')
      icon.style.removeProperty('transform')
      icon.style.removeProperty('opacity')
      icon.style.removeProperty('visibility')
      loopSignatures.delete(item.occurrenceId)
      release()
    }
    const cancel = () => {
      if (!active) return
      tween?.kill()
      finish()
    }
    release = continuous.track(item.occurrenceId, cancel)
    loopSignatures.set(item.occurrenceId, signature)
    icon.classList.add('is-motion-looping')
    context.add(() => {
      tween =
        item.status === 'running'
          ? gsap.to(icon, {
              rotation: 360,
              duration: 0.9,
              ease: 'none',
              repeat: -1,
              overwrite: true,
              onInterrupt: finish,
            })
          : gsap.fromTo(
              icon,
              { scale: 0.86, autoAlpha: 0.56 },
              {
                scale: 1.08,
                autoAlpha: 1,
                duration: 0.68,
                ease: 'sine.inOut',
                repeat: -1,
                yoyo: true,
                overwrite: true,
                onInterrupt: finish,
              },
            )
    })
  }

  function syncContinuous(): void {
    if (!context) return
    const root = options.scope.value
    const currentContext = motionContext(options.change.value.source)
    if (
      !root ||
      !currentContext.loops ||
      !currentContext.synced ||
      currentContext.replay ||
      currentContext.suspended ||
      currentContext.hidden
    ) {
      continuous.cancelAll()
      loopSignatures.clear()
      return
    }
    const viewport = root.getBoundingClientRect()
    const elements = new Map(
      [...root.querySelectorAll<HTMLElement>('[data-workflow-occurrence-id]')].map((element) => [
        element.dataset.workflowOccurrenceId!,
        element,
      ]),
    )
    const visible = new Set<string>()
    const icons = new Map<string, HTMLElement>()
    for (const item of frame.value) {
      const element = elements.get(item.occurrenceId)
      const icon = element?.querySelector<HTMLElement>('[data-workflow-state-icon]')
      if (!element || !icon || !intersects(element.getBoundingClientRect(), viewport)) continue
      visible.add(item.occurrenceId)
      icons.set(item.occurrenceId, icon)
    }
    const active = selectWorkflowMotionLoops(
      frame.value,
      { ...currentContext, visibleOccurrenceIds: visible },
      MAX_CONTINUOUS,
    )
    const desired = new Set(active.map((item) => item.occurrenceId))
    for (const occurrenceId of [...loopSignatures.keys()]) {
      if (desired.has(occurrenceId)) continue
      continuous.cancel(occurrenceId)
      loopSignatures.delete(occurrenceId)
    }
    for (const item of active) {
      const icon = icons.get(item.occurrenceId)
      if (icon) startLoop(item, icon)
    }
  }

  function scheduleContinuousRefresh(): void {
    const token = ++refreshGeneration
    void nextTick(() => {
      if (token === refreshGeneration) syncContinuous()
    })
  }

  // This watcher is registered before the projection baseline watcher so a live signal compares
  // the previous committed frame with the newly projected one in the same Vue flush.
  watch(
    options.change,
    (signal) => {
      const before = previousFrame
      const next = frame.value
      previousFrame = next
      signaledFrame = next
      const token = ++animationGeneration
      if (signal.source !== 'live' || signal.rootChatId !== options.rootChatId.value) {
        oneShots.cancelAll()
        scheduleContinuousRefresh()
        return
      }
      void nextTick(() => runOneShots(before, next, signal.source, token))
    },
    { flush: 'post' },
  )
  watch(
    frame,
    (next) => {
      if (next !== signaledFrame) {
        ++animationGeneration
        oneShots.cancelAll()
      }
      signaledFrame = undefined
      previousFrame = next
      scheduleContinuousRefresh()
    },
    { flush: 'post' },
  )
  watch(
    [options.rootChatId, options.replay, options.suspended, options.synced, options.hidden, spec],
    () => {
      ++animationGeneration
      oneShots.cancelAll()
      scheduleContinuousRefresh()
    },
    { flush: 'post' },
  )

  useGsap(options.scope, (gsapContext) => {
    context = gsapContext
    scheduleContinuousRefresh()
  })
  onScopeDispose(() => {
    ++animationGeneration
    ++refreshGeneration
    oneShots.cancelAll()
    continuous.cancelAll()
    loopSignatures.clear()
    context = undefined
  })

  return { refreshVisibility: scheduleContinuousRefresh }
}
