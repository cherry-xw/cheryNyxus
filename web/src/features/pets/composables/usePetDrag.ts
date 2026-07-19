import { onBeforeUnmount, ref } from 'vue'
import type { PetInstance } from '../types/types'

/**
 * PetSprite 拖拽 composable：长按拖拽 + 短按抚摸状态机 + pet 身体 hover。
 *
 * pointerdown 启 300ms 定时器；长按超时或移动超阈值 -> startDrag（setPointerCapture）。
 * 短按（<300ms 且未超阈值）松开 -> 不拖拽，让 click 触发 clickPet 抚摸。
 * 拖拽结束 pointerup 紧随触发 click -> suppressClick 抑制（避免拖拽完又抚摸）。
 *
 * ghost 首领可拖（ghostDraggable）；非首领 ghost onPointerDown 早返（仅 click -> history）。
 * petHover 由 .pet / .head-row pointerenter/leave 驱动，供 z-index 提层 + useStreamBubble retain。
 *
 * 行为/常量与原 PetSprite 内联实现一致，仅下沉抽取。
 */

/** composable 所需 props 子集（PetSprite props 的 pet + ghostDraggable）。 */
export interface PetDragProps {
  pet: PetInstance
  ghostDraggable?: boolean
}

/** composable 所需 emit 子集（startDrag/drag/endDrag/hover/clickPet）。 */
export interface PetDragEmit {
  (e: 'startDrag', pet: PetInstance, event: PointerEvent): void
  (e: 'drag', pet: PetInstance, event: PointerEvent): void
  (e: 'endDrag', pet: PetInstance, event: PointerEvent): void
  (e: 'hover', pet: PetInstance, hovering: boolean): void
  (e: 'clickPet', pet: PetInstance): void
}

// 长按拖拽：pointerdown 启 300ms 定时器，超时或移动超阈值才 startDrag；
// 短按（<300ms 且未超阈值）松开 -> 不拖拽，让 click 触发抚摸（clickPet）。
// 拖拽结束的 pointerup 会紧随触发 click -> suppressClick 抑制，避免拖拽完又抚摸。
const LONG_PRESS_MS = 300
const DRAG_THRESHOLD_PX = 5

export function usePetDrag(props: PetDragProps, emit: PetDragEmit) {
  // hover 保持：pet 身体 hover 期间，即使 retainUntil 过期也保持气泡显示 + z-index 提层。
  const petHover = ref(false)

  let downX = 0
  let downY = 0
  let longPressTimer: ReturnType<typeof setTimeout> | undefined
  let draggingStarted = false
  let suppressClick = false

  function beginDrag(target: HTMLElement, event: PointerEvent): void {
    draggingStarted = true
    target.setPointerCapture(event.pointerId)
    emit('startDrag', props.pet, event)
  }

  function onPointerDown(event: PointerEvent): void {
    // ghost 首领可拖（ghostDraggable）；非首领 ghost 不响应拖拽/长按（仅 click -> history），早返让 onClick 直接触发
    console.log('[drag] onPointerDown', {
      isGhost: props.pet.isGhost,
      ghostDraggable: props.ghostDraggable,
      id: props.pet.instanceId,
    })
    if (props.pet.isGhost && !props.ghostDraggable) return
    downX = event.clientX
    downY = event.clientY
    draggingStarted = false
    const target = event.currentTarget as HTMLElement
    longPressTimer = setTimeout(() => {
      longPressTimer = undefined
      beginDrag(target, event)
    }, LONG_PRESS_MS)
  }

  function onPointerMove(event: PointerEvent): void {
    if (longPressTimer !== undefined) {
      // 长按等待中：移动超阈值 -> 立即进拖拽（同长按超时路径）
      const dx = event.clientX - downX
      const dy = event.clientY - downY
      if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
        clearTimeout(longPressTimer)
        longPressTimer = undefined
        const target = event.currentTarget as HTMLElement
        beginDrag(target, event)
        emit('drag', props.pet, event)
      }
      return
    }
    if (draggingStarted) {
      emit('drag', props.pet, event)
    }
  }

  // pointerup / pointercancel 共用：短按取消定时器；拖拽中收尾 endDrag。
  function endPointer(event: PointerEvent): void {
    const target = event.currentTarget as HTMLElement
    if (longPressTimer !== undefined) {
      clearTimeout(longPressTimer)
      longPressTimer = undefined
      draggingStarted = false
      return
    }
    if (draggingStarted) {
      if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId)
      }
      emit('endDrag', props.pet, event)
      draggingStarted = false
      suppressClick = true
    }
  }

  function onPetEnter(): void {
    petHover.value = true
    emit('hover', props.pet, true)
  }

  function onPointerLeave(event: PointerEvent): void {
    // 长按等待中离开 .pet：取消定时器，避免离开后异步 startDrag 无人响应
    if (longPressTimer !== undefined) {
      clearTimeout(longPressTimer)
      longPressTimer = undefined
      draggingStarted = false
    }
    petHover.value = false
    emit('hover', props.pet, false)
  }

  // ghost hover 绑 head-row（.pet pointer-events:none 不捕 hover，命中区=emoji）；
  // 非 ghost 仍由 .pet 大区 hover，此 handler 早返避双触发。
  function onHeadRowEnter(): void {
    if (!props.pet.isGhost) return
    onPetEnter()
  }
  function onHeadRowLeave(event: PointerEvent): void {
    if (!props.pet.isGhost) return
    onPointerLeave(event)
  }

  function onClick(): void {
    if (suppressClick) {
      suppressClick = false
      return
    }
    emit('clickPet', props.pet)
  }

  onBeforeUnmount(() => {
    if (longPressTimer !== undefined) clearTimeout(longPressTimer)
  })

  return {
    petHover,
    onPetEnter,
    onPointerDown,
    onPointerMove,
    endPointer,
    onPointerLeave,
    onHeadRowEnter,
    onHeadRowLeave,
    onClick,
  }
}
