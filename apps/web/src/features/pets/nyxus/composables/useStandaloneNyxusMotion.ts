import { onBeforeUnmount, onMounted, ref, type ComponentPublicInstance } from 'vue'
import { frameCoordinator, type DisplayFrame } from '../../../../utils/frameCoordinator'
import { gsap } from 'gsap'
import {
  createNyxusPointerDrift,
  nyxusAvoidanceTarget,
  nyxusPointerTarget,
  type NyxusAvoidanceObstacle,
  NYXUS_POINTER_TRAVEL_MAX_MS,
  NYXUS_POINTER_TRAVEL_MIN_MS,
  NYXUS_POINTER_DRIFT_MAX_MS,
  NYXUS_POINTER_DRIFT_MIN_MS,
  NYXUS_POINTER_MAX_SPEED,
  NYXUS_POINTER_MIN_SPEED,
} from '../motion/nyxusPointerMotion'

export interface ViewportPoint {
  x: number
  y: number
}

const LONG_PRESS_MS = 300
const DRAG_THRESHOLD = 5
const RESUME_DELAY_MS = 650
const EDGE_X = 74
const EDGE_TOP = 74
const EDGE_BOTTOM = 92

export function clampNyxusPoint(
  point: ViewportPoint,
  width: number,
  height: number,
): ViewportPoint {
  return {
    x: Math.min(Math.max(point.x, EDGE_X), Math.max(EDGE_X, width - EDGE_X)),
    y: Math.min(Math.max(point.y, EDGE_TOP), Math.max(EDGE_TOP, height - EDGE_BOTTOM)),
  }
}

function randomPoint(width: number, height: number): ViewportPoint {
  const availableWidth = Math.max(1, width - EDGE_X * 2)
  const availableHeight = Math.max(1, height - EDGE_TOP - EDGE_BOTTOM)
  return {
    x: EDGE_X + availableWidth * (0.16 + Math.random() * 0.68),
    y: EDGE_TOP + availableHeight * (0.14 + Math.random() * 0.72),
  }
}

export function clampNyxusPointerTarget(
  pointer: ViewportPoint,
  drift: ViewportPoint,
  width: number,
  height: number,
): ViewportPoint {
  return clampNyxusPoint(nyxusPointerTarget(pointer, drift), width, height)
}

export function useStandaloneNyxusMotion(
  active: () => boolean,
  paused: () => boolean,
  onDragStart?: () => void,
  obstacles: () => readonly NyxusAvoidanceObstacle[] = () => [],
) {
  const position: ViewportPoint = { x: 0, y: 0 }
  const dragging = ref(false)

  let unsubscribeFrame: (() => void) | undefined
  let setAnchorX: ReturnType<typeof gsap.quickSetter> | undefined
  let setAnchorY: ReturnType<typeof gsap.quickSetter> | undefined
  let target: ViewportPoint = { x: 0, y: 0 }
  let pointer: ViewportPoint | undefined
  let pointerDrift = createNyxusPointerDrift()
  let velocityX = 0
  let velocityY = 0
  let movementSpeed = 1.3
  let restUntil = 0
  let travelUntil = 0
  let travelStartedAt = 0
  let resumeAt = 0
  let longPressTimer: ReturnType<typeof setTimeout> | undefined
  let down:
    | {
        pointerId: number
        clientX: number
        clientY: number
        offsetX: number
        offsetY: number
        element: HTMLElement
      }
    | undefined
  let suppressClick = false

  function writePosition(): void {
    setAnchorX?.(position.x)
    setAnchorY?.(position.y)
  }

  function anchorRef(element: Element | ComponentPublicInstance | null): void {
    if (!(element instanceof HTMLElement)) {
      setAnchorX = undefined
      setAnchorY = undefined
      return
    }
    setAnchorX = gsap.quickSetter(element, 'x', 'px')
    setAnchorY = gsap.quickSetter(element, 'y', 'px')
    writePosition()
  }

  function chooseTarget(now: number): void {
    if (pointer) {
      pointerDrift = createNyxusPointerDrift()
      target = clampNyxusPointerTarget(pointer, pointerDrift, window.innerWidth, window.innerHeight)
      movementSpeed =
        NYXUS_POINTER_MIN_SPEED +
        Math.random() * (NYXUS_POINTER_MAX_SPEED - NYXUS_POINTER_MIN_SPEED)
    } else {
      target = randomPoint(window.innerWidth, window.innerHeight)
      movementSpeed =
        NYXUS_POINTER_MIN_SPEED +
        Math.random() * (NYXUS_POINTER_MAX_SPEED - NYXUS_POINTER_MIN_SPEED)
    }
    travelStartedAt = now
    travelUntil =
      now +
      NYXUS_POINTER_TRAVEL_MIN_MS +
      Math.random() * (NYXUS_POINTER_TRAVEL_MAX_MS - NYXUS_POINTER_TRAVEL_MIN_MS)
    restUntil = 0
  }

  function beginRest(now: number): void {
    velocityX = 0
    velocityY = 0
    travelUntil = 0
    travelStartedAt = 0
    restUntil =
      now +
      NYXUS_POINTER_DRIFT_MIN_MS +
      Math.random() * (NYXUS_POINTER_DRIFT_MAX_MS - NYXUS_POINTER_DRIFT_MIN_MS)
  }

  function keepInBounds(): void {
    const bounded = clampNyxusPoint(position, window.innerWidth, window.innerHeight)
    position.x = bounded.x
    position.y = bounded.y
    writePosition()
  }

  function step(frame: DisplayFrame): void {
    const { now, deltaSeconds: dt } = frame

    if (active() && !dragging.value) {
      const avoidance = nyxusAvoidanceTarget(position, obstacles())
      if (avoidance && !paused() && now >= resumeAt) {
        target = clampNyxusPoint(avoidance, window.innerWidth, window.innerHeight)
        movementSpeed = NYXUS_POINTER_MAX_SPEED
        restUntil = 0
        travelUntil = Number.POSITIVE_INFINITY
      } else if (travelUntil === 0 && now >= restUntil && now >= resumeAt) {
        chooseTarget(now)
      }
      if (paused() || now < resumeAt || now < restUntil) {
        const damping = Math.exp(-3.2 * dt)
        velocityX *= damping
        velocityY *= damping
      } else {
        const dx = target.x - position.x
        const dy = target.y - position.y
        const distance = Math.hypot(dx, dy)
        const speed = Math.hypot(velocityX, velocityY)
        if (
          (distance < 3 && speed < 0.35) ||
          (now >= travelUntil && travelUntil !== Number.POSITIVE_INFINITY && speed < 0.35)
        ) {
          beginRest(now)
        } else {
          const travelProgress =
            travelUntil === Number.POSITIVE_INFINITY
              ? 0.5
              : Math.min(1, Math.max(0, (now - travelStartedAt) / (travelUntil - travelStartedAt)))
          // 航段两端使用长缓入、长缓出；避让也走相同的慢启动曲线。
          const rampIn = Math.min(1, travelProgress / 0.28)
          const rampOut = Math.min(1, (1 - travelProgress) / 0.32)
          const desiredSpeed = movementSpeed * Math.min(rampIn, rampOut)
          const desiredX = distance > 3 ? (dx / distance) * desiredSpeed : 0
          const desiredY = distance > 3 ? (dy / distance) * desiredSpeed : 0
          const steering = Math.min(1, dt * 0.55)
          velocityX += (desiredX - velocityX) * steering
          velocityY += (desiredY - velocityY) * steering
          position.x += velocityX * dt
          position.y += velocityY * dt
          keepInBounds()
        }
      }
    }
  }

  function trackPointer(event: PointerEvent): void {
    pointer = { x: event.clientX, y: event.clientY }
  }

  function beginDrag(): void {
    if (!down || dragging.value) return
    dragging.value = true
    velocityX = 0
    velocityY = 0
    onDragStart?.()
    // 长按计时器触发时 Event.currentTarget 已被浏览器清空，必须使用 pointerdown 时保存的元素。
    if (!down.element.hasPointerCapture(down.pointerId))
      down.element.setPointerCapture(down.pointerId)
  }

  function onPointerDown(event: PointerEvent): void {
    if (event.button !== 0 || !active()) return
    const element = event.currentTarget
    if (!(element instanceof HTMLElement)) return
    event.preventDefault()
    down = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      offsetX: position.x - event.clientX,
      offsetY: position.y - event.clientY,
      element,
    }
    longPressTimer = setTimeout(() => {
      longPressTimer = undefined
      beginDrag()
    }, LONG_PRESS_MS)
  }

  function onPointerMove(event: PointerEvent): void {
    if (!down || down.pointerId !== event.pointerId) return
    if (
      !dragging.value &&
      Math.hypot(event.clientX - down.clientX, event.clientY - down.clientY) > DRAG_THRESHOLD
    ) {
      if (longPressTimer) clearTimeout(longPressTimer)
      longPressTimer = undefined
      beginDrag()
    }
    if (!dragging.value) return
    position.x = event.clientX + down.offsetX
    position.y = event.clientY + down.offsetY
    keepInBounds()
  }

  function endPointer(event: PointerEvent): void {
    if (longPressTimer) clearTimeout(longPressTimer)
    longPressTimer = undefined
    if (!down || down.pointerId !== event.pointerId) return
    if (down.element.hasPointerCapture(event.pointerId))
      down.element.releasePointerCapture(event.pointerId)
    if (dragging.value) {
      suppressClick = true
      dragging.value = false
      resumeAt = performance.now() + RESUME_DELAY_MS
      chooseTarget(performance.now())
    }
    down = undefined
  }

  function consumeSuppressedClick(): boolean {
    if (!suppressClick) return false
    suppressClick = false
    return true
  }

  function onResize(): void {
    keepInBounds()
    target = clampNyxusPoint(target, window.innerWidth, window.innerHeight)
  }

  onMounted(() => {
    const initial = randomPoint(window.innerWidth, window.innerHeight)
    position.x = initial.x
    position.y = initial.y
    writePosition()
    target = randomPoint(window.innerWidth, window.innerHeight)
    restUntil = performance.now() + 2500 + Math.random() * 2500
    window.addEventListener('resize', onResize)
    window.addEventListener('pointermove', trackPointer, { passive: true })
    unsubscribeFrame = frameCoordinator.subscribe(step)
  })

  onBeforeUnmount(() => {
    unsubscribeFrame?.()
    window.removeEventListener('resize', onResize)
    window.removeEventListener('pointermove', trackPointer)
    if (longPressTimer) clearTimeout(longPressTimer)
  })

  return {
    position,
    dragging,
    onPointerDown,
    onPointerMove,
    endPointer,
    consumeSuppressedClick,
    anchorRef,
  }
}
