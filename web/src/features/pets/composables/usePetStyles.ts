import { computed, onMounted, onScopeDispose, shallowRef } from 'vue'
import type { Ref } from 'vue'
import type { StreamState } from '@/application/public'
import { useAgentsStore, useThemeStore } from '@/application/public'
import {
  faceMotion,
  ghostFaceMotion,
  ghostSpriteMotion,
  handMotion,
  speechMotion,
  spriteMotion,
} from '@/domain/pets/motion/animation'
import type { PetInstance } from '@/domain/pets/types'
import { frameCoordinator } from '@/utils/frameCoordinator'

/**
 * PetSprite 视觉计算 composable：所有 computed style / motion config / 辅助函数。
 * 输入 pet + stream + petHover，输出 PetBody / PetBubbles / orchestrator 所需的全部视觉数据。
 */

import { hashHue, petBodyZIndex, speechZIndex } from '@/domain/pets/motion/style'

export { hashHue, petBodyZIndex, speechZIndex } from '@/domain/pets/motion/style'

/** 深色主题下把 pet accent 提亮成浅色（脸/手部颜文字文本在深底可读）。 */
function lightenAccent(hex: string, weight = 0.72): string {
  const from = Number.parseInt(hex.replace('#', ''), 16)
  const r = Math.round(((from >> 16) & 255) * (1 - weight) + 255 * weight)
  const g = Math.round(((from >> 8) & 255) * (1 - weight) + 255 * weight)
  const b = Math.round((from & 255) * (1 - weight) + 255 * weight)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/** 气泡底边锚定在状态条上方；下方 name / toolbar 的尺寸不参与计算。 */
const BUBBLE_OFFSET_Y_BASE = 20

export function usePetStyles(
  pet: () => PetInstance,
  stream: () => StreamState | undefined,
  petHover: Ref<boolean>,
  paused: () => boolean,
) {
  const agents = useAgentsStore()
  const themeStore = useThemeStore()
  const pose = shallowRef({ x: pet().x, y: pet().y })
  let unsubscribePose: (() => void) | undefined
  let lastPoseAt = 0
  onMounted(() => {
    unsubscribePose = frameCoordinator.subscribe(({ now }) => {
      if (now - lastPoseAt < 50) return
      lastPoseAt = now
      pose.value = { x: pet().x, y: pet().y }
    })
  })
  onScopeDispose(() => unsubscribePose?.())

  // === 气泡 offset：恒为 base（running-row absolute 不再顶动脸位） ===
  const bubbleOffsetY = computed(() => BUBBLE_OFFSET_Y_BASE)

  // === 表情 / 手部 / 名字 ===
  const faceGlyph = computed(() =>
    pet().isGhost ? (pet().ghostFace ?? '👻') : pet().face[pet().mood],
  )
  const leftHand = computed(() => pet().hands[pet().mood].left)
  const rightHand = computed(() => pet().hands[pet().mood].right)
  const nameChars = computed(() => Array.from(pet().name))

  // === motion configs ===
  const sprite = computed(() => (pet().isGhost ? ghostSpriteMotion() : spriteMotion(pet().action)))
  const face = computed(() => (pet().isGhost ? ghostFaceMotion() : faceMotion(pet().mood)))
  const leftHandMotion = computed(() => handMotion(pet().action, 'left'))
  const rightHandMotion = computed(() => handMotion(pet().action, 'right'))
  const speech = speechMotion()

  // === style computeds ===
  const style = computed(() => ({
    zIndex: String(petBodyZIndex(pet(), petHover.value)),
    '--pet-color': pet().color,
    '--pet-accent': themeStore.theme === 'dark' ? lightenAccent(pet().accent) : pet().accent,
    '--pet-direction': pet().isMaster ? '1' : String(pet().direction),
    '--pet-scale': pet().isGhost ? '0.7' : pet().isMaster ? '1' : '0.75',
    '--tribe-hue': `${hashHue(pet().tribe)}deg`,
  }))

  const speechStyle = computed(() => ({
    left: `${pose.value.x + pet().width / 2}px`,
    top: `${pose.value.y + bubbleOffsetY.value}px`,
    zIndex: String(speechZIndex(pet())),
  }))

  // 提问/审批气泡与 pet 共享同一交互层（speechZIndex 区间，不再 400 置顶盖住工作台/对话框）。
  // 交互窗口归属由「接力棒」仲裁（workbenchConsumesChat）：工作台打开时 pet 气泡隐藏、工作台消费，
  // 关闭后交还 pet 兜底；本 style 仅负责坐标与层级，显隐由 PetBubbles 门控。
  const approvalStyle = computed(() => ({
    left: `${pose.value.x + pet().width / 2}px`,
    top: `${pose.value.y + bubbleOffsetY.value}px`,
    zIndex: String(speechZIndex(pet())),
  }))

  const runningTools = computed(() => stream()?.runningTools ?? [])

  const todoEnabled = computed(
    () => !pet().isGhost && agents.senseGroupsHasSense(pet().runtime?.senseGroup, 'update_todo'),
  )
  const hasTodoData = computed(() => {
    const hasCurrent = (stream()?.currentTodo?.length ?? 0) > 0
    const h = stream()?.history
    const hasInHistory = !!h && h.some((it) => it.senseCalls?.some((c) => c.name === 'update_todo'))
    // 也检查 runningTools（实时运行中的 sense），使 TodoPanel 在子 agent 开始执行时能立即显示
    const hasInRunning = (stream()?.runningTools ?? []).some((t) => t.name === 'update_todo')
    return hasCurrent || hasInHistory || hasInRunning
  })
  const todoPanelStyle = computed(() => ({
    position: 'absolute' as const,
    left: `${pose.value.x + pet().width + 8}px`,
    top: `${pose.value.y + bubbleOffsetY.value}px`,
    zIndex: String(speechZIndex(pet())),
  }))

  const petIconsStyle = computed(() => ({
    position: 'absolute' as const,
    left: `${pose.value.x + pet().width}px`,
    top: `${pose.value.y + 16}px`,
    zIndex: String(speechZIndex(pet()) - 1),
  }))

  const classes = computed(() => [
    `is-${pet().action}`,
    `mood-${pet().mood}`,
    {
      'is-master': pet().isMaster,
      'is-sub': !pet().isMaster,
      'is-ghost': pet().isGhost,
      'is-paused': paused(),
    },
  ])

  return {
    faceGlyph,
    leftHand,
    rightHand,
    nameChars,
    sprite,
    face,
    leftHandMotion,
    rightHandMotion,
    speech,
    style,
    speechStyle,
    approvalStyle,
    runningTools,
    todoEnabled,
    hasTodoData,
    todoPanelStyle,
    petIconsStyle,
    classes,
  }
}
