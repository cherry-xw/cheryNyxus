<script setup lang="ts">
/**
 * PetSprite orchestrator：组合 usePetDrag + useStreamBubble + usePetStyles，
 * 渲染 PetBubbles + PetBody + TodoPanel + PetIcons。
 * 所有视觉计算/样式/motion 配置下沉 usePetStyles；
 * 拖拽交互下沉 usePetDrag；气泡显隐下沉 useStreamBubble。
 */
import PetBody from './PetBody.vue'
import PetBubbles from './PetBubbles.vue'
import PetIcons from './PetIcons.vue'
import GhostDot from './GhostDot.vue'
import TodoPanel from '@/features/agent/cards/TodoPanel.vue'
import type { StreamState } from '@/application/public'
import { usePetDrag } from '../composables/usePetDrag'
import { usePetStyles } from '../composables/usePetStyles'
import { useStreamBubble } from '../composables/useStreamBubble'
import type { PetInstance } from '@/domain/pets/types'

const props = defineProps<{
  pet: PetInstance
  paused: boolean
  stream?: StreamState
  /** 气泡 stream 对应 chatId（master=活跃根 / 子=自身）；接力棒判定用。缺省回退 pet.chatId。 */
  streamChatId?: string
  attentionCount?: number
  positionRef?: (element: HTMLElement | null) => void
}>()

const emit = defineEmits<{
  startDrag: [pet: PetInstance, event: PointerEvent]
  drag: [pet: PetInstance, event: PointerEvent]
  endDrag: [pet: PetInstance, event: PointerEvent]
  hover: [pet: PetInstance, hovering: boolean]
  clickPet: [pet: PetInstance]
  strokePet: [pet: PetInstance]
  doubleClickPet: [pet: PetInstance]
  history: [pet: PetInstance]
  abort: [pet: PetInstance]
  destroy: [pet: PetInstance]
  compact: [pet: PetInstance]
  resume: [pet: PetInstance]
  attention: [pet: PetInstance]
}>()

const {
  petHover,
  onPetEnter,
  onPointerDown,
  onPointerMove,
  endPointer,
  onPointerLeave,
  onHeadRowEnter,
  onHeadRowLeave,
  onClick,
} = usePetDrag(props, emit)

const {
  isBusy,
  showWorkMain,
  showThinkingButton,
  thinkingOnly,
  hasContent,
  displayThinking,
  displayContent,
  renderedContent,
  workTextRef,
  onWorkTextScroll,
  onBubbleEnter,
  onBubbleLeave,
} = useStreamBubble({
  isGhost: () => props.pet.isGhost,
  isWorking: () => props.pet.isWorking,
  stream: () => props.stream,
})

const {
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
} = usePetStyles(
  () => props.pet,
  () => props.stream,
  petHover,
  () => props.paused,
)

// workTextRef 在模板中会被自动解包为 HTMLElement | null，因此通过闭包 setter 把 DOM 节点回写给 ref
function setWorkTextRef(el: HTMLElement | null): void {
  workTextRef.value = el
}
</script>

<template>
  <GhostDot v-if="pet.isGhost" :pet="pet" :style="style" />
  <div v-else class="pet-wrap" data-desktop-hit @pointerenter="onPetEnter" @pointerleave="onPointerLeave">
    <PetBubbles
      :pet="pet"
      :chat-id="streamChatId ?? pet.chatId"
    :stream="stream"
    :position-ref="positionRef"
      :has-stream="true"
      :is-busy="isBusy"
      :show-work-main="showWorkMain"
      :show-thinking-button="showThinkingButton"
      :thinking-only="thinkingOnly"
      :has-content="hasContent"
      :display-thinking="displayThinking"
      :display-content="displayContent"
      :rendered-content="renderedContent"
      :speech-style="speechStyle"
      :approval-style="approvalStyle"
      :speech="speech"
      :work-text-ref="setWorkTextRef"
      :on-work-text-scroll="onWorkTextScroll"
      @bubble-enter="onBubbleEnter"
      @bubble-leave="onBubbleLeave"
    >
      <template v-if="$slots.dialog" #dialog="{ pet: p }">
        <slot name="dialog" :pet="p" />
      </template>
    </PetBubbles>
    <div v-if="todoEnabled && hasTodoData" class="todo-anchor" :style="todoPanelStyle">
      <TodoPanel :pet="pet" />
    </div>
    <PetIcons
      :chat-id="pet.chatId"
      :stream="stream"
      :attention-count="attentionCount"
      :style="petIconsStyle"
      @attention="emit('attention', pet)"
    />
    <PetBody
      :pet="pet"
      :paused="paused"
      :classes="classes"
      :style="style"
      :face-glyph="faceGlyph"
      :left-hand="leftHand"
      :right-hand="rightHand"
      :name-chars="nameChars"
      :sprite="sprite"
      :face="face"
      :left-hand-motion="leftHandMotion"
      :right-hand-motion="rightHandMotion"
      :running-tools="runningTools"
      :is-busy="isBusy"
      :stream="stream"
      @history="emit('history', pet)"
      @abort="emit('abort', pet)"
      @destroy="emit('destroy', pet)"
      @compact="emit('compact', pet)"
      @resume="emit('resume', pet)"
      @pointer-down="onPointerDown"
      @pointer-move="onPointerMove"
      @end-pointer="endPointer"
      @head-row-enter="onHeadRowEnter"
      @head-row-leave="onHeadRowLeave"
      @click-pet="onClick"
      @double-click-pet="emit('doubleClickPet', pet)"
    />
  </div>
</template>

<style scoped lang="less">
/* orchestrator 层无自有样式 — 子组件各自 scoped */
</style>
