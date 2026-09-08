import {
  computed,
  inject,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  watch,
  type ComputedRef,
  type InjectionKey,
  type Ref,
} from 'vue'
import { SETTINGS_ACTIVE_TAB_KEY } from '../config/constants'
import { initialScatterPosition } from '../model/cardScatterLayout'
import { useMotionPreference } from '@/composables/useMotionPreference'

/** Single-canvas scatter; initial random offsets remain stable for this visit. */
export type GlobalCardAnchor =
  | 'default'
  | 'editor'
  | 'limits'
  | 'logger'
  | 'compression'
  | 'memory-global'
  | 'memory-workspace'
  | 'motion'
const ANCHORS: GlobalCardAnchor[] = [
  'default',
  'editor',
  'limits',
  'logger',
  'compression',
  'memory-global',
  'memory-workspace',
  'motion',
]

/** 长按阈值（ms）：按下保持超过此时长才进入拖拽；短按只置顶，避免一点即拖。 */
const LONG_PRESS_MS = 320
/** 内缩 clamp（px）：卡 left/top 钳在 [SHIELD, size - SHIELD]，防 box-shadow 被画布边缘裁切。 */
const SHIELD_PX = 8
/** z-index 地板：避开 hover 2/3 与 modal 270-320 层。 */
const BASE_Z = 10

/** 卡片运行时位置与层级。 */
interface CardRuntime {
  x: number
  y: number
  z: number
}

/** 暴露给模板 :style 的 CSS 自定义属性包。 */
export interface CardStyle {
  '--cx': string
  '--cy': string
  '--i': string
  zIndex: number
}

/** 初始化卡片；测量完成前由 ready 隐藏。 */
function initialCards(): Record<GlobalCardAnchor, CardRuntime> {
  const out = {} as Record<GlobalCardAnchor, CardRuntime>
  ANCHORS.forEach((k) => {
    out[k] = { x: 0, y: 0, z: BASE_Z }
  })
  return out
}

export function useCardScatter(
  canvasRef: Readonly<Ref<HTMLElement | null>>,
  visibleAnchors: ComputedRef<GlobalCardAnchor[]>,
): {
  ready: Ref<boolean>
  activeAnchor: Ref<GlobalCardAnchor | null>
  isActive: ComputedRef<boolean>
  draggingAnchor: Ref<GlobalCardAnchor | null>
  pressedAnchor: Ref<GlobalCardAnchor | null>
  enterSeq: Ref<number>
  cardStyle: (anchor: GlobalCardAnchor) => CardStyle
  cardClass: (anchor: GlobalCardAnchor) => Record<string, boolean>
  cardNumber: (anchor: GlobalCardAnchor) => number
  raise: (anchor: GlobalCardAnchor) => void
  onPointerDown: (anchor: GlobalCardAnchor, e: PointerEvent) => void
  onPointerMove: (e: PointerEvent) => void
  endPointer: (e: PointerEvent) => void
  playEntry: () => void
  onEnterEnd: (anchor: GlobalCardAnchor) => void
} {
  // activeTab inject：v-show 切换时 RO 可能错过（同一帧大小未变），watch 是兜底。
  const activeTab = inject(SETTINGS_ACTIVE_TAB_KEY)
  const { effectiveMode } = useMotionPreference()
  const random = Object.fromEntries(
    ANCHORS.map((anchor) => [anchor, [Math.random(), Math.random()]]),
  )
  let layoutSignature = ''
  /** 本 tab 是否处于激活（控制左下角数字索引 Teleport 的显隐）。 */
  const isActive = computed(() => !!activeTab && activeTab.value === 'global')

  /** 每张卡的运行时 pos/z（响应式，驱动 :style）。 */
  const cards = reactive<Record<GlobalCardAnchor, CardRuntime>>(initialCards())

  /** 布局是否完成（防止 RO 重算覆盖用户拖拽）。 */
  const ready = ref(false)
  const activeAnchor = ref<GlobalCardAnchor | null>(null)
  const draggingAnchor = ref<GlobalCardAnchor | null>(null)
  /** pointerdown 即置位，pointerup/cancel 清零；CSS .is-pressed 用。 */
  const pressedAnchor = ref<GlobalCardAnchor | null>(null)
  /** 入场动画序号（递增触发 :class 重绑，方便调试/扩展）。 */
  const enterSeq = ref(0)
  /** 当前正入场动画中的卡集合（animationend / 兜底定时器清除）。 */
  const enteringSet = reactive(new Set<GlobalCardAnchor>())

  // 单调递增的最高 z（每次 raise 自增）。非响应式：仅通过 cards[a].z 驱动 topZCard computed。
  let topZ = BASE_Z
  let pendingEntry = false
  let entryFallbackTimer: ReturnType<typeof setTimeout> | undefined

  /** 当前 z 最高的可见卡（用于 .is-top 视觉特效：边光 + 加深模糊）。 */
  const topZCard = computed<GlobalCardAnchor | null>(() => {
    let maxZ = -1
    let maxAnchor: GlobalCardAnchor | null = null
    for (const a of visibleAnchors.value) {
      const z = cards[a].z
      if (z > maxZ) {
        maxZ = z
        maxAnchor = a
      }
    }
    return maxAnchor
  })

  // ── 拖拽态（非响应式：仅拖拽期内部用） ──
  let downX = 0
  let downY = 0
  let downCardX = 0
  let downCardY = 0
  let activePointerId: number | null = null
  let activePointerTarget: HTMLElement | null = null
  /** 长按计时器：到点 arm 拖拽。 */
  let dragArmTimer: ReturnType<typeof setTimeout> | undefined
  /** 是否已 arm（长按到点）→ 此后 pointermove 才真正拖动。 */
  let armed = false

  let ro: ResizeObserver | undefined
  let stopActiveTabWatch: (() => void) | undefined

  function layout(): void {
    const el = canvasRef.value
    if (!el || !el.clientWidth || !el.clientHeight) return
    const width = el.clientWidth
    const height = el.clientHeight
    el.style.setProperty('--card-width', `${Math.min(360, width * 0.48, width - 24)}px`)
    el.style.setProperty('--card-max-height', `${Math.max(1, height - 24)}px`)
    const elements = visibleAnchors.value
      .map((anchor) => ({
        anchor,
        element: el.querySelector<HTMLElement>(`[data-anchor="${anchor}"]`)!,
      }))
      .filter((item) => item.element)
    const signature = JSON.stringify([
      width,
      height,
      elements.map(({ element }) => [element.offsetWidth, element.offsetHeight]),
    ])
    if (signature === layoutSignature) return
    layoutSignature = signature
    elements.forEach(({ anchor, element }, index) => {
      const card = { width: element.offsetWidth, height: element.offsetHeight }
      if (!ready.value) {
        Object.assign(
          cards[anchor],
          initialScatterPosition(
            { width, height },
            card,
            index,
            random[anchor]![0]!,
            random[anchor]![1]!,
          ),
        )
      } else {
        // Resizing only clamps existing positions; it never reshuffles a user's arrangement.
        cards[anchor].x = Math.max(12, Math.min(width - card.width - 12, cards[anchor].x))
        cards[anchor].y = Math.max(12, Math.min(height - card.height - 12, cards[anchor].y))
      }
    })
    ready.value = true
    if (pendingEntry) {
      pendingEntry = false
      playEntry()
    }
  }

  function cardStyle(anchor: GlobalCardAnchor): CardStyle {
    const c = cards[anchor]
    const idx = visibleAnchors.value.indexOf(anchor)
    return {
      '--cx': `${c.x}px`,
      '--cy': `${c.y}px`,
      '--i': String(idx >= 0 ? idx : 0),
      zIndex: c.z,
    }
  }

  function cardClass(anchor: GlobalCardAnchor): Record<string, boolean> {
    return {
      'is-active': activeAnchor.value === anchor,
      'is-dragging': draggingAnchor.value === anchor,
      'is-pressed': pressedAnchor.value === anchor,
      'is-top': topZCard.value === anchor,
      'is-entering': enteringSet.has(anchor),
    }
  }

  function cardNumber(anchor: GlobalCardAnchor): number {
    const i = visibleAnchors.value.indexOf(anchor)
    return i >= 0 ? i + 1 : 0
  }

  /** 置顶：topZ 单调递增后赋给目标卡。幂等（连续点击同一卡只是 z 不变）。 */
  function raise(anchor: GlobalCardAnchor): void {
    topZ += 1
    cards[anchor].z = topZ
    activeAnchor.value = anchor
  }

  function onPointerDown(anchor: GlobalCardAnchor, e: PointerEvent): void {
    // 仅主键响应（右键 / 中键放过，交给原生菜单）
    if (e.button !== 0) return
    raise(anchor)
    if (
      (e.target as Element | null)?.closest(
        'input, textarea, button, select, a, [role="combobox"], [contenteditable="true"]',
      )
    )
      return
    pressedAnchor.value = anchor
    downX = e.clientX
    downY = e.clientY
    downCardX = cards[anchor].x
    downCardY = cards[anchor].y
    activePointerId = e.pointerId
    activePointerTarget = e.currentTarget as HTMLElement
    armed = false
    // 长按才进拖拽：短按只置顶（+ 拿起回弹）。到点 armDrag 捕获指针 + 锁选区。
    if (dragArmTimer) clearTimeout(dragArmTimer)
    dragArmTimer = setTimeout(armDrag, LONG_PRESS_MS)
  }

  /** 长按到点：捕获指针、锁 body 选区、标记 armed，此后 pointermove 才拖动。 */
  function armDrag(): void {
    if (pressedAnchor.value === null || activePointerTarget === null) return
    armed = true
    draggingAnchor.value = pressedAnchor.value
    try {
      activePointerTarget.setPointerCapture(activePointerId!)
    } catch {
      /* setPointerCapture 抛异常不致命：仍按客户端坐标拖 */
    }
    document.body.style.userSelect = 'none'
  }

  function onPointerMove(e: PointerEvent): void {
    if (activePointerId !== e.pointerId || pressedAnchor.value === null) return
    if (!armed) return // 长按未到点不拖（短按只置顶）
    const anchor = pressedAnchor.value
    const dx = e.clientX - downX
    const dy = e.clientY - downY
    const el = canvasRef.value
    if (!el || !activePointerTarget) return
    const width = activePointerTarget.offsetWidth
    const height = activePointerTarget.offsetHeight
    const x = Math.max(SHIELD_PX, Math.min(el.clientWidth - width - SHIELD_PX, downCardX + dx))
    const y = Math.max(SHIELD_PX, Math.min(el.clientHeight - height - SHIELD_PX, downCardY + dy))
    Object.assign(cards[anchor], { x, y })
  }

  function endPointer(e: PointerEvent): void {
    if (activePointerId !== e.pointerId) return
    if (dragArmTimer) {
      clearTimeout(dragArmTimer)
      dragArmTimer = undefined
    }
    if (armed && activePointerTarget?.hasPointerCapture(e.pointerId)) {
      activePointerTarget.releasePointerCapture(e.pointerId)
    }
    if (draggingAnchor.value !== null) draggingAnchor.value = null
    if (pressedAnchor.value !== null) pressedAnchor.value = null
    document.body.style.userSelect = ''
    activePointerId = null
    activePointerTarget = null
    armed = false
  }

  function playEntry(): void {
    if (effectiveMode.value === 'reduced') return
    // 准入：未 ready 时延后到 layout 成功后再放（cards 此时无位置，坠落无意义）。
    if (!ready.value) {
      pendingEntry = true
      return
    }
    enteringSet.clear()
    for (const a of visibleAnchors.value) enteringSet.add(a)
    enterSeq.value += 1
    // 兜底定时：animationend 万一漏触（CSS 动画被覆盖/打断），保证 .is-entering 不残留。
    if (entryFallbackTimer) clearTimeout(entryFallbackTimer)
    // 7 卡最大 stagger 6*55ms=330ms + duration 500ms + 200ms 缓冲 = 1030ms
    entryFallbackTimer = setTimeout(() => {
      enteringSet.clear()
      entryFallbackTimer = undefined
    }, 1100)
  }

  function onEnterEnd(anchor: GlobalCardAnchor): void {
    enteringSet.delete(anchor)
    if (enteringSet.size === 0 && entryFallbackTimer) {
      clearTimeout(entryFallbackTimer)
      entryFallbackTimer = undefined
    }
  }

  onMounted(() => {
    window.addEventListener('pointerup', endPointer)
    window.addEventListener('pointercancel', endPointer)
    // 主路径：ResizeObserver 在 v-show 由 hidden → visible 时会触发（clientWidth 0 → 非 0）。
    const el = canvasRef.value
    if (el && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(() => layout())
      ro.observe(el)
      el.querySelectorAll<HTMLElement>('[data-anchor]').forEach((card) => ro!.observe(card))
    }
    // 兜底 1：mount 时若已可见（非默认 tab 切到 global 而后又重开等边缘路径），nextTick 直接尝试。
    nextTick(layout)
    // 兜底 2：watch activeTab——v-show 同帧大小不变时 RO 可能不触发，显式切 tab 时再 layout + playEntry。
    //   getter 形式（() => activeTab.value）兼容 Readonly<Ref>，避开 Ref vs Readonly<Ref> 赋值窄化。
    if (activeTab) {
      const tabRef = activeTab
      stopActiveTabWatch = watch(
        () => tabRef.value,
        (tab) => {
          if (tab === 'global') {
            nextTick(() => {
              layout()
              playEntry()
            })
          }
        },
        { immediate: true },
      )
    }
  })

  onBeforeUnmount(() => {
    window.removeEventListener('pointerup', endPointer)
    window.removeEventListener('pointercancel', endPointer)
    ro?.disconnect()
    ro = undefined
    stopActiveTabWatch?.()
    if (entryFallbackTimer) {
      clearTimeout(entryFallbackTimer)
      entryFallbackTimer = undefined
    }
    if (dragArmTimer) {
      clearTimeout(dragArmTimer)
      dragArmTimer = undefined
    }
    // 防御：拖拽中卸载（理论不达）还原 body 样式。
    document.body.style.userSelect = ''
  })

  return {
    ready,
    activeAnchor,
    isActive,
    draggingAnchor,
    pressedAnchor,
    enterSeq,
    cardStyle,
    cardClass,
    cardNumber,
    raise,
    onPointerDown,
    onPointerMove,
    endPointer,
    playEntry,
    onEnterEnd,
  }
}

/**
 * useCardScatter 返回的散落 API 类型。GlobalTab 调 useCardScatter 后 provide 此对象，
 * ScatterCard 经 SCATTER_KEY inject 取用 → 散落交互细节对业务卡片透明。
 */
export type ScatterApi = ReturnType<typeof useCardScatter>

/** provide/inject 键：把散落 API 从编排器（GlobalTab）传入各包裹卡（ScatterCard）。 */
export const SCATTER_KEY: InjectionKey<ScatterApi> = Symbol('CardScatter')
