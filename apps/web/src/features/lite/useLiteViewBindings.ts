import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Plus, Top } from '@element-plus/icons-vue'
import { ElPopover, ElTooltip, ElUpload } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { MorphIcon } from 'morphicons/vue'
import { useMotionTier } from '@/composables/useMotionTier'
import { THINKING_ICONS, toolCallIcon } from './clusterIcons'
import { classifyToolType, toolTypeGlyph } from './executionMonitor'
import { useLiteViewController, type LiteViewControllerProps } from './useLiteViewController'
import { useInstructionSuggestions } from '../agent/composer/useInstructionSuggestions'
import InstructionSuggestions from '../agent/composer/InstructionSuggestions.vue'
import MediaThumbStrip from '../agent/composer/media/MediaThumbStrip.vue'
import { splitCommandPrompt } from '../agent/composables/commands'
import TaskPlanMarker from '../agent/task-plan/TaskPlanMarker.vue'
import { durationColor, durationSeverity, readableDuration } from '@/domain/chat/executionDuration'

export function useLiteViewBindings(props: Readonly<LiteViewControllerProps>) {
  function nodeTime(node: { elapsedMs: number; kind: string }): string {
    const timeout = props.modelRequestTimeoutMs ?? 600000
    const elapsed = readableDuration(node.elapsedMs)
    return timeout > 0 && (node.kind === 'root-agent' || node.kind === 'child-agent')
      ? `${elapsed}/${readableDuration(timeout)}` : elapsed
  }

  const controller = useLiteViewController(props)

  const {
    DetailDrawer,
    LiteMarkdown,
    LiteScrollbar,
    aborting,
    activeLane,
    autoGrowInput,
    closeDetail,
    connectionBlocked,
    detailNode,
    detailNodeIndex,
    entryDispatch,
    entryExpanded,
    entryHasMore,
    entryPreview,
    errorBanner,
    focusNodeFromTrajectory,
    focusNodeId,
    formatElapsed,
    hideBarTip,
    history,
    hoverCall,
    hoverNode,
    hydrationLabel,
    inputText,
    inputLines,
    interactionNeedsAttentionForCall,
    isDetailNode,
    isPlainRowContent,
    isRowFocused,
    isThinkingOpen,
    laneTabs,
    lite,
    liteInputEl,
    liteStatus,
    monitor,
    monitorEl,
    moveBarTip,
    mediaAttachments,
    mediaDisabledReason,
    mediaHint,
    mediaServicesByType,
    nodeKindLabel,
    nodeTipText,
    nodeToneVars,
    onErrorAction,
    onInputKeydown,
    onMonitorScroll,
    onMediaSelected,
    onResume,
    onSend,
    onStop,
    onTrajectoryKeydown,
    onTrajectoryWheel,
    openNodeDetail,
    openToolCallDetail,
    operationBlockReason,
    resetTrajectoryZoom,
    removeMedia,
    resuming,
    rootUi,
    rowKey,
    runDetailOpen,
    runDetailText,
    runStatusLabel,
    sending,
    setRowEl,
    showBarTip,
    showThinkingMark,
    showsRowContent,
    tipAction,
    tipPos,
    toolCallStatus,
    toolCallTipText,
    toggleMediaVariant,
    toggleThinking,
    toggleRunDetail,
    toolTypeLabel,
    trajectoryBarStyle,
    trajectoryLayout,
    trajectoryZoom,
    uploading,
    userSegments,
    visibleRows,
    withdrawQueuedInput,
  } = controller

  const activeLitePlan = computed(() => {
    if (monitor.value.status !== 'running' && monitor.value.status !== 'waiting') return undefined
    const planNode = history.value.nodes
      .filter((node) => node.sourceChatId === activeLane.value && node.todoPlan)
      .at(-1)
    return planNode?.todoPlan
  })

  const activeLitePlanNodeId = computed(() => {
    if (!activeLitePlan.value) return undefined
    return (
      history.value.nodes
        .slice()
        .reverse()
        .find((node) => node.sourceChatId === activeLane.value && node.kind === 'tool' && node.active)
        ?.nodeId ??
      history.value.nodes
        .slice()
        .reverse()
        .find((node) => node.sourceChatId === activeLane.value && node.todoPlan)?.nodeId
    )
  })

  const mediaKinds = [
    { kind: 'image', label: '图片' },
    { kind: 'video', label: '视频' },
    { kind: 'audio', label: '音频' },
  ] as const

  const menu = useInstructionSuggestions({
    chatId: () => props.rootChatId,
    preset: () => props.presetName,
    text: () => inputText.value,
    input: liteInputEl,
    update: (value) => {
      inputText.value = value
    },
    resize: autoGrowInput,
  })

  function onLiteInput(): void {
    void nextTick(menu.refresh)
    autoGrowInput()
  }

  function onLiteKeydown(event: KeyboardEvent): void {
    if (!menu.keydown(event)) onInputKeydown(event)
  }

  // ── cluster 小按钮可变形图标（morphicons）：状态变化时弹簧变形为状态图标（终态），
  // 平时静止；动效档位约定与 WorkflowMorphIcon 一致——精简动效/关闭装饰档下不做变形动画。 ──
  const { spec } = useMotionTier()

  const clusterMorphReducedMotion = computed(() =>
    spec.value.mode === 'full' && spec.value.decoration !== 'off' ? 'user' : 'always',
  )

  // ── 思考标记动态图标：运行中的模型响应在 brain / brain-cog 间切换（MorphIcon 变形过渡），
  // 并配合主题色呼吸（CSS）；完成/失败后静止在 idle 图标。多个思考节点共享一个切换 tick。 ──
  const hasActiveThinking = computed(() =>
    visibleRows.value.some((row) =>
      (row.nodes ?? []).some((node) => node.active && showThinkingMark(node)),
    ),
  )

  const thinkingFlip = ref(false)

  let thinkingTimer: ReturnType<typeof setInterval> | undefined

  watch(hasActiveThinking, (on) => {
    if (on) {
      thinkingTimer = setInterval(() => {
        thinkingFlip.value = !thinkingFlip.value
      }, 1600)
    } else if (thinkingTimer) {
      clearInterval(thinkingTimer)
      thinkingTimer = undefined
      thinkingFlip.value = false
    }
  })

  onBeforeUnmount(() => {
    if (thinkingTimer) clearInterval(thinkingTimer)
  })

  // ── 输入框展开态（精简模式同款交互，与对话模式一致）：默认保持 6 行上限，
  // 展开后最高到窗口一半（由 CSS .lite-input.is-expanded 承接）。 ──
  const expandedInput = ref(false)

  function toggleExpandInput(): void {
    expandedInput.value = !expandedInput.value
    // 类切换后重算高度：展开时立即给足可视高度，收起时回到内容高度（CSS 上限兜底）。
    void nextTick(() => autoGrowInput())
  }

  // 展开按钮仅在输入超过 2 行时出现（controller 测量 inputLines）；内容回落 2 行以内时
  // 收起展开态（按钮随之隐藏，避免「已展开却无法收起」）。
  watch(inputLines, (lines) => {
    if (lines <= 2) expandedInput.value = false
  })

  // 挂载时按既有草稿重算高度/行数（恢复的长草稿直接撑高 + 展开按钮立即可见）；
  // 容器宽度变化导致自动换行改变时重算，避免行数/高度停留在旧宽度。
  let inputResizeObserver: ResizeObserver | null = null

  let lastInputWidth = 0

  onMounted(() => {
    void nextTick(() => autoGrowInput())
    const el = liteInputEl.value
    if (el) {
      lastInputWidth = el.clientWidth
      inputResizeObserver = new ResizeObserver(() => {
        const width = el.clientWidth
        if (width !== lastInputWidth) {
          lastInputWidth = width
          autoGrowInput()
        }
      })
      inputResizeObserver.observe(el)
    }
  })

  onBeforeUnmount(() => inputResizeObserver?.disconnect())

  return {
    Plus,
    Top,
    ElPopover,
    ElTooltip,
    ElUpload,
    MorphIcon,
    THINKING_ICONS,
    InstructionSuggestions,
    MediaThumbStrip,
    TaskPlanMarker,
    nodeTime,
    controller,
    DetailDrawer,
    LiteMarkdown,
    LiteScrollbar,
    aborting,
    activeLane,
    autoGrowInput,
    closeDetail,
    connectionBlocked,
    detailNode,
    detailNodeIndex,
    entryDispatch,
    entryExpanded,
    entryHasMore,
    entryPreview,
    errorBanner,
    focusNodeFromTrajectory,
    focusNodeId,
    formatElapsed,
    hideBarTip,
    history,
    hoverCall,
    hoverNode,
    hydrationLabel,
    inputText,
    inputLines,
    interactionNeedsAttentionForCall,
    isDetailNode,
    isPlainRowContent,
    isRowFocused,
    isThinkingOpen,
    laneTabs,
    lite,
    liteInputEl,
    liteStatus,
    monitor,
    monitorEl,
    moveBarTip,
    mediaAttachments,
    mediaDisabledReason,
    mediaHint,
    mediaServicesByType,
    nodeKindLabel,
    nodeTipText,
    nodeToneVars,
    onErrorAction,
    onInputKeydown,
    onMonitorScroll,
    onMediaSelected,
    onResume,
    onSend,
    onStop,
    onTrajectoryKeydown,
    onTrajectoryWheel,
    openNodeDetail,
    openToolCallDetail,
    operationBlockReason,
    resetTrajectoryZoom,
    removeMedia,
    resuming,
    rootUi,
    rowKey,
    runDetailOpen,
    runDetailText,
    runStatusLabel,
    sending,
    setRowEl,
    showBarTip,
    showThinkingMark,
    showsRowContent,
    tipAction,
    tipPos,
    toolCallStatus,
    toolCallTipText,
    toggleMediaVariant,
    toggleThinking,
    toggleRunDetail,
    toolTypeLabel,
    trajectoryBarStyle,
    trajectoryLayout,
    trajectoryZoom,
    uploading,
    userSegments,
    visibleRows,
    withdrawQueuedInput,
    activeLitePlan,
    activeLitePlanNodeId,
    mediaKinds,
    menu,
    onLiteInput,
    onLiteKeydown,
    spec,
    clusterMorphReducedMotion,
    hasActiveThinking,
    thinkingFlip,
    thinkingTimer,
    expandedInput,
    toggleExpandInput,
    inputResizeObserver,
    lastInputWidth,
  }
}
