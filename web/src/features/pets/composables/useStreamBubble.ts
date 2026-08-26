import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  toValue,
  watch,
  type MaybeRefOrGetter,
} from 'vue'
import type { StreamState } from '@/application/public'
import { renderMarkdown } from '@/utils/markdown'

/**
 * 工作气泡 composable：双气泡显隐 + retainUntil 保留 + 流式 auto-scroll。
 * PetSprite / NyxusCore 共用；不依赖 PetInstance，接收 MaybeRefOrGetter（值/ref/getter）保持响应式。
 *
 * thinking 阶段（thinking 非空 && content 空）：主气泡全空间显 thinking。
 * thinking 结束（content 非空）：主气泡显 content（md）；thinking 收成按钮，hover 弹气泡显完整内容。
 * done 后 content/thinking 保留 20s（retainUntil）；工作气泡自身 hover 期间保持。
 *
 * 气泡显隐门控仅收 bubbleHover（工作气泡自身 hover，本 composable 自管）——
 * retainUntil 过期后悬浮身体不复现历史气泡。
 */

/** composable 所需 props 子集（PetSprite / NyxusCore 共用；不依赖 PetInstance）。 */
export interface StreamBubbleProps {
  isGhost?: MaybeRefOrGetter<boolean | undefined>
  isWorking: MaybeRefOrGetter<boolean>
  stream?: MaybeRefOrGetter<StreamState | undefined>
}

export function useStreamBubble(props: StreamBubbleProps) {
  // 响应式解包：调用方可传值 / ref / getter，统一转 computed 保持响应。
  const isGhost = computed(() => toValue(props.isGhost) ?? false)
  const isWorking = computed(() => toValue(props.isWorking))
  const stream = computed(() => toValue(props.stream))

  // hover 保持：工作气泡自身 hover 期间，即使 retainUntil 过期也保持显示。
  const bubbleHover = ref(false)

  // retainUntil 过期检测：nowTick 每秒刷新驱动 done 后保留期到期重渲染。
  const nowTick = ref(Date.now())
  const retainTimer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    nowTick.value = Date.now()
  }, 1000)

  // === 工作气泡状态 ===
  const hasStreamContent = computed(
    () => !!stream.value && (!!stream.value.thinking || !!stream.value.content),
  )
  const retainActive = computed(
    () => !!stream.value?.retainUntil && stream.value.retainUntil > nowTick.value,
  )
  const hasStream = computed(
    () =>
      !isGhost.value &&
      hasStreamContent.value &&
      (isWorking.value || retainActive.value || bubbleHover.value),
  )
  // === busy-indicator 状态（与气泡显示解耦；语义对齐"还在做事"） ===
  // 不含 hover / retainUntil：hover 仅保持气泡显示；retain 期不视为"还在做事"。
  // isWorking || runningTools.length > 0 || approval != null || questionBatches 非空
  const hasPendingQuestion = computed(() => (stream.value?.questionBatches.length ?? 0) > 0)
  const isBusy = computed(
    () =>
      !isGhost.value &&
      (isWorking.value ||
        (stream.value?.runningTools?.length ?? 0) > 0 ||
        !!stream.value?.approval ||
        hasPendingQuestion.value),
  )
  const hasContent = computed(() => !!stream.value?.content)
  const thinkingOnly = computed(() => !!stream.value?.thinking && !stream.value?.content)
  const showWorkMain = computed(() => hasStream.value && (thinkingOnly.value || hasContent.value))
  // thinking 按钮：思考结束（有 content）且有 thinking 时，content 气泡左下角显按钮，hover 弹气泡。
  const showThinkingButton = computed(
    () => hasStream.value && hasContent.value && !!stream.value?.thinking,
  )
  // 显示单次响应全部内容（不截取）
  const displayThinking = computed(() => stream.value?.thinking ?? '')
  const displayContent = computed(() => stream.value?.content ?? '')
  const renderedContent = computed(() => renderMarkdown(displayContent.value))

  // === 流式滚动保持底部 ===
  const workTextRef = ref<HTMLElement | null>(null)
  const userScrolledUp = ref(false)
  // 新流开始（thinking/content 从空变非空）-> 重置 userScrolledUp
  watch(
    () => stream.value?.thinking ?? '',
    (v, prev) => {
      if (v && !prev) userScrolledUp.value = false
    },
  )
  watch(
    () => stream.value?.content ?? '',
    (v, prev) => {
      if (v && !prev) userScrolledUp.value = false
    },
  )
  // 流式追加 -> 自动滚到底部（用户手动上滚时暂停）
  watch(
    () => [stream.value?.thinking, stream.value?.content],
    () => {
      if (userScrolledUp.value) return
      nextTick(() => {
        const el = workTextRef.value
        if (el) el.scrollTop = el.scrollHeight
      })
    },
  )
  function onWorkTextScroll(): void {
    const el = workTextRef.value
    if (!el) return
    // 距底部 >20px 视为用户主动上滚
    userScrolledUp.value = el.scrollHeight - el.scrollTop - el.clientHeight > 20
  }

  function onBubbleEnter(): void {
    bubbleHover.value = true
  }
  function onBubbleLeave(): void {
    bubbleHover.value = false
  }

  onBeforeUnmount(() => {
    if (retainTimer !== undefined) clearInterval(retainTimer)
  })

  return {
    hasStream,
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
  }
}
