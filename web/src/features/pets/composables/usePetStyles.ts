import { computed } from 'vue'
import type { Ref } from 'vue'
import type { StreamState } from '@/stores'
import { useAgentsStore, useThemeStore } from '@/stores'
import {
  faceMotion,
  ghostFaceMotion,
  ghostSpriteMotion,
  handMotion,
  speechMotion,
  spriteMotion,
} from '../motion/petMotion'
import type { PetInstance } from '../types/types'

/**
 * PetSprite 视觉计算 composable：所有 computed style / motion config / 辅助函数。
 * 输入 pet + stream + petHover，输出 PetBody / PetBubbles / orchestrator 所需的全部视觉数据。
 */

import { APPROVAL_Z_INDEX, hashHue, petBodyZIndex, speechZIndex } from '../motion/petStyle'

export { APPROVAL_Z_INDEX, hashHue, petBodyZIndex, speechZIndex } from '../motion/petStyle'

/** 深色主题下把 pet accent 提亮成浅色（脸/手部颜文字文本在深底可读）。 */
function lightenAccent(hex: string, weight = 0.72): string {
  const from = Number.parseInt(hex.replace('#', ''), 16)
  const r = Math.round(
    ((from >> 16) & 255) * (1 - weight) + 255 * weight,
  )
  const g = Math.round(((from >> 8) & 255) * (1 - weight) + 255 * weight)
  const b = Math.round((from & 255) * (1 - weight) + 255 * weight)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`
}

/** 气泡锚点基准值：气泡底部贴 status-row 上方 16px。offset=28（44-16）。
 *  running-row 已改 absolute（零布局高度），脸位不再随工具数变动，无需 running 补偿。 */
const BUBBLE_OFFSET_Y_BASE = 28

export function usePetStyles(
  pet: () => PetInstance,
  stream: () => StreamState | undefined,
  petHover: Ref<boolean>,
  paused: () => boolean,
) {
  const agents = useAgentsStore()
  const themeStore = useThemeStore()

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
    transform: `translate3d(${pet().x}px, ${pet().y}px, 0)`,
    zIndex: String(petBodyZIndex(pet(), petHover.value)),
    '--pet-color': pet().color,
    '--pet-accent':
      themeStore.theme === 'dark' ? lightenAccent(pet().accent) : pet().accent,
    '--pet-direction': pet().isMaster ? '1' : String(pet().direction),
    '--pet-scale': pet().isGhost ? '0.7' : pet().isMaster ? '1' : '0.75',
    '--tribe-hue': `${hashHue(pet().tribe)}deg`,
  }))

  const speechStyle = computed(() => ({
    left: `${pet().x + pet().width / 2}px`,
    top: `${pet().y + bubbleOffsetY.value}px`,
    zIndex: String(speechZIndex(pet())),
  }))

  const approvalStyle = computed(() => ({
    left: `${pet().x + pet().width / 2}px`,
    top: `${pet().y + bubbleOffsetY.value}px`,
    zIndex: String(APPROVAL_Z_INDEX),
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
    left: `${pet().x + pet().width + 8}px`,
    top: `${pet().y + bubbleOffsetY.value}px`,
    zIndex: String(speechZIndex(pet())),
  }))

  const petIconsStyle = computed(() => ({
    position: 'absolute' as const,
    left: `${pet().x + pet().width}px`,
    top: `${pet().y + 16}px`,
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
