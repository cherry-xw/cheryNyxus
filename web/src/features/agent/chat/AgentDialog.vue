<script setup lang="ts">
/**
 * AgentDialog orchestrator：发消息弹窗（runtime 切换合一）。
 * C-3 抽取后仅保留「快速发送 composer 弹窗」单例面板（Pet 单击打开）。
 * 节点树工作台已抽到 WorkbenchDialog（多窗口），此处不再承载 .workbench-shell 子树。
 * 状态/逻辑下沉 useAgentDialogOptions；角色卡下沉 RoleConfigPopover；媒体预览下沉 MediaPreviewBar。
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { AnimatePresence, motion } from 'motion-v'
import { ElPopover, ElTooltip } from 'element-plus'
import RoleConfigPopover from '../dialog/RoleConfigPopover.vue'
import AgentComposer from '../dialog/AgentComposer.vue'
import ConversationTargetPicker from '../dialog/ConversationTargetPicker.vue'
import RoutingTraceWindow from '../dialog/RoutingTraceWindow.vue'
import WorkspaceSessionBrowser from '../dialog/WorkspaceSessionBrowser.vue'
import ContextBreakdownTip from '../toolbar/ContextBreakdownTip.vue'
import { fmtTokens } from '../toolbar/contextBreakdown'
import { useAgentDialogOptions } from '../dialog/useAgentDialogOptions'
import type { RouteStatus } from '../dialog/conversationTargetRouting'
import { desktopBridge } from '@/features/desktop/desktopBridge'
import { useAgentsStore, useInteractionsStore } from '@/stores'
import { OVERLAY_Z_INDEX } from '@/styles/overlayLayers'

const props = withDefaults(defineProps<{ native?: boolean }>(), { native: false })
const agents = useAgentsStore()
const interactions = useInteractionsStore()
// 共用单蒙层：仅当 AgentDialog 是栈顶 overlay 且非 pet/nyxus 来源时其蒙层带 blur，否则透明。
// pet 发送窗口与 nyxus 直接发消息浮动窗要求无遮罩（可拖动、不叠层），故 activeDialogSource 为
// 'pet' 或 'nyxus' 时始终透明；'history' 为历史抽屉式模态，带遮罩。
const isTopMask = computed(
  () =>
    agents.topOverlay === 'agentDialog' &&
    agents.activeDialogSource !== 'pet' &&
    agents.activeDialogSource !== 'nyxus',
)

const MotionDiv = motion.div

// desktop surface（Electron 全工作区透明窗）：pet/nyxus 来源为无遮罩浮动窗，overlay 的
// 全屏 DOM 不能拦截命中测试——置 pointer-events:none 让穿透判定只认 panel 实体，
// panel 内部恢复 auto（agentDialog.less 的 .dialog-panel）。
const isFloatingOverlay = computed(
  () => agents.activeDialogSource === 'pet' || agents.activeDialogSource === 'nyxus',
)

const {
  chatId,
  pet,
  presetName,
  brains,
  senseGroups,
  config,
  senseTools,
  roleSelections,
  primaryRole,
  text,
  editorRef,
  commandOptions,
  commandTabs,
  activeCommandTab,
  comboCommandGroups,
  showCommandMenu,
  activeCommandIndex,
  commandMenuRef,
  roleMenuRef,
  matchingRoleMentions,
  showRoleMenu,
  activeRoleIndex,
  uploading,
  mediaHint,
  mediaAttachments,
  sending,
  loading,
  error,
  primarySelection,
  orderedRoleSelections,
  mediaServicesByType,
  close: closeAgentDialog,
  handleSend,
  onEditorKeydown,
  onEditorInput,
  onEditorSelectionChange,
  onEditorPaste,
  selectCommand,
  selectCommandTab,
  selectRoleMention,
  resetEditor,
  removeMedia,
  onMediaSelected,
  senseEntries,
  senseTool,
  brainConfig,
  supportsTools,
} = useAgentDialogOptions()

/** 快速发送 composer 单例面板：仅有活跃 chatId 时可见（Pet 单击/PetStage 打开）。 */
interface QuickTargetSelection {
  target: string | 'new'
  source: 'ai' | 'user'
  confidence?: number
}
interface ConversationTargetPickerExpose {
  routeForSend: (draft: string) => Promise<QuickTargetSelection | undefined>
}
const targetPickerRef = ref<ConversationTargetPickerExpose>()
const quickTarget = ref<QuickTargetSelection>()
const quickRoutingPending = ref(false)
const quickAutoMode = ref(false)
function setQuickRoutingPending(pending: boolean): void {
  quickRoutingPending.value = pending
}
function clearAiQuickTarget(): void {
  if (quickTarget.value?.source === 'ai') quickTarget.value = undefined
}
function enableAiQuickTarget(): void {
  quickTarget.value = undefined
  error.value = null
}
// 切会话清残留目标：钢琴键/历史列表/retarget 等外部切换不经过 picker，旧会话的选择
// （尤其 'new'）对新会话无意义；composer 原生窗 keepAlive 不销毁组件，残留 'new' 会在
// 下次发送时静默 chat.create 新会话。生命周期约定见 docs/interaction.md chat.route.suggest。
watch(chatId, () => {
  quickTarget.value = undefined
})
const dialogView = computed({
  get: () => agents.activeDialogView,
  set: (view: 'composer' | 'attention' | 'tree') => {
    agents.activeDialogView = view
  },
})
const quickTargetRequired = computed(
  () =>
    (agents.activeDialogSource === 'pet' || agents.activeDialogSource === 'nyxus') &&
    !!presetName.value,
)
const quickPresetId = computed(() => {
  if (pet.value?.presetId) return pet.value.presetId
  const summary = chatId.value
    ? agents.historyList.find((item) => item.chatId === chatId.value)
    : undefined
  return summary?.presetId
})
/** 与 quickPresetId 同源配对的预设名（pet.preset / 同条 summary.preset），工作台入口随窗携带。 */
const quickPresetName = computed(() => {
  if (pet.value?.preset) return pet.value.preset
  const summary = chatId.value
    ? agents.historyList.find((item) => item.chatId === chatId.value)
    : undefined
  return summary?.preset
})
/**
 * Pet quick chat and its preset workbench are mutually exclusive. Keep the
 * dialog state and draft alive so closing the workbench restores the bubble.
 */
const petWorkbenchOpen = computed(() => {
  if (agents.activeDialogSource !== 'pet') return false
  const presetId = quickPresetId.value
  return !!presetId && !!agents.workbenchWindows[presetId]
})
const dialogVisible = computed(() => !!chatId.value && !petWorkbenchOpen.value)
const quickSessions = computed(() =>
  (agents.historyList ?? [])
    .filter(
      (item) =>
        !item.parentChatId &&
        (quickPresetId.value
          ? item.presetId === quickPresetId.value
          : !!presetName.value && item.preset === presetName.value),
    )
    .sort(
      (a, b) =>
        (b.lastUserActivityAt ?? b.createdAt ?? 0) - (a.lastUserActivityAt ?? a.createdAt ?? 0),
    ),
)
const workspaceAttentionCount = computed(
  () => interactions.pending.filter((item) => item.presetId === quickPresetId.value).length,
)
const quickRoutingEnabled = computed(() => {
  const preset = presetName.value ? config.value?.presets?.[presetName.value] : undefined
  return !!preset?.shadows?.conversationRouting
})
watch(
  quickRoutingEnabled,
  (enabled) => {
    quickAutoMode.value = enabled
  },
  { immediate: true },
)

// ── 路由小窗实时状态（由 ConversationTargetPicker 经 route-status 事件上抛） ──
const routeStatus = reactive<RouteStatus>({ routing: false, thinking: '', content: '' })
const traceHover = ref(false)
const traceAutoHideUntil = ref(0)
let traceAutoHideTimer: ReturnType<typeof setTimeout> | undefined
/** 路由结束后最终选定的目标会话 id；undefined=路由未完成/失败，null=新建对话。 */
const finalizedTargetChatId = computed<string | null | undefined>(
  () => routeStatus.trace?.response.toolCall.arguments.chatId,
)
/** 目标会话是否仍存在：新建对话恒显示；历史会话若已被删除则不再展示路由小窗。 */
const finalizedTargetStillExists = computed(() => {
  const id = finalizedTargetChatId.value
  if (id === undefined) return false
  if (id === null) return true
  return (agents.historyList ?? []).some((item) => item.chatId === id)
})
/** 显示：路由进行中 / 悬浮 AI 路由状态指示 / 流式结束后停留 10s（目标会话已删除则不显示）。 */
const showTraceWindow = computed(() => {
  if (routeStatus.routing) return true
  if (!finalizedTargetStillExists.value) return false
  return traceHover.value || Date.now() < traceAutoHideUntil.value
})
function onRouteStatus(status: RouteStatus): void {
  const wasRouting = routeStatus.routing
  routeStatus.routing = status.routing
  routeStatus.trace = status.trace
  routeStatus.thinking = status.thinking
  routeStatus.content = status.content
  if (wasRouting && !status.routing) {
    // 流式结束：停留 10s 后自动关闭（新一轮路由/hover 会打断）。
    traceAutoHideUntil.value = Date.now() + 10_000
    if (traceAutoHideTimer) clearTimeout(traceAutoHideTimer)
    traceAutoHideTimer = setTimeout(() => {
      traceAutoHideUntil.value = 0
    }, 10_000)
  }
}

function onTraceHover(hover: boolean): void {
  traceHover.value = hover
}

// ── 发送面板可拖动（pet 无遮罩小窗，允许拖动定位） ──
const panelEl = ref<HTMLElement | null>(null)
const panelPos = ref<{ x: number; y: number } | null>(null)
/** 拖拽中的边框占位框位置（fixed）；null=未在拖拽。拖动只更新它（transform 驱动，避免实时重排面板），松开后整体瞬移。 */
const dragPreview = ref<{ x: number; y: number; w: number; h: number } | null>(null)
let dragCtx:
  | { pointerX: number; pointerY: number; origX: number; origY: number; w: number; h: number }
  | undefined
function bindPanelEl(el: unknown): void {
  panelEl.value =
    el instanceof HTMLElement ? el : ((el as { $el?: HTMLElement } | null)?.$el ?? null)
}
function onHeaderPointerDown(e: PointerEvent): void {
  if (props.native) return
  const target = e.target as HTMLElement
  if (target.closest('button, input, a, [contenteditable="true"], .el-tooltip')) return
  const panel = panelEl.value
  if (!panel) return
  const rect = panel.getBoundingClientRect()
  if (!panelPos.value) panelPos.value = { x: rect.left, y: rect.top }
  dragCtx = {
    pointerX: e.clientX,
    pointerY: e.clientY,
    origX: panelPos.value.x,
    origY: panelPos.value.y,
    w: rect.width,
    h: rect.height,
  }
  // 拖拽中只移动边框占位框（transform 驱动，GPU 合成，不触发面板重排），松开后瞬移面板。
  dragPreview.value = { x: panelPos.value.x, y: panelPos.value.y, w: rect.width, h: rect.height }
  window.addEventListener('pointermove', onPanelPointerMove)
  window.addEventListener('pointerup', onPanelPointerUp)
  // 不可 preventDefault：会阻止 mousedown 默认的文档聚焦。失焦/切 tab 回来首次点击时，
  // 页面若得不到焦点则 Chromium 不派发后续 pointermove，导致无法拖动。
  // 拖拽中防文本选择已由 .dialog-head 的 user-select:none 承担，无需 preventDefault。
}
function onPanelPointerMove(e: PointerEvent): void {
  if (!dragCtx) return
  dragPreview.value = {
    x: dragCtx.origX + (e.clientX - dragCtx.pointerX),
    y: dragCtx.origY + (e.clientY - dragCtx.pointerY),
    w: dragCtx.w,
    h: dragCtx.h,
  }
}
function onPanelPointerUp(): void {
  const preview = dragPreview.value
  if (dragCtx && preview) {
    // 鼠标松开：面板整体瞬移到占位框位置（无过渡）。
    panelPos.value = { x: preview.x, y: preview.y }
  }
  dragPreview.value = null
  dragCtx = undefined
  window.removeEventListener('pointermove', onPanelPointerMove)
  window.removeEventListener('pointerup', onPanelPointerUp)
}
const panelStyle = computed(() =>
  panelPos.value
    ? {
        position: 'fixed',
        left: `${panelPos.value.x}px`,
        top: `${panelPos.value.y}px`,
        margin: '0',
      }
    : {},
)
/** 拖拽占位框样式：fixed + transform 跟随；width/height 在 pointerdown 时记录一次，避免拖拽中实时读布局。 */
const dragPreviewStyle = computed(() =>
  dragPreview.value
    ? {
        position: 'fixed' as const,
        left: '0px',
        top: '0px',
        width: `${dragPreview.value.w}px`,
        height: `${dragPreview.value.h}px`,
        transform: `translate3d(${dragPreview.value.x}px, ${dragPreview.value.y}px, 0)`,
      }
    : {},
)
/** 路由小窗锚定在发送面板右侧；实时读面板 rect，拖动/布局变化自适应。 */
const traceWindowPos = computed(() => {
  if (props.native) return { left: '12px', top: '52px' }
  void panelPos.value // 面板拖动变更时触发重算；未拖动时读当前居中布局的实际 rect。
  const panel = panelEl.value
  if (!panel) return { left: '0px', top: '0px' }
  const rect = panel.getBoundingClientRect()
  return { left: `${rect.right + 10}px`, top: `${Math.max(8, rect.top)}px` }
})
watch(chatId, (v) => {
  if (!v) {
    routeStatus.routing = false
    routeStatus.trace = undefined
    routeStatus.thinking = ''
    routeStatus.content = ''
    traceAutoHideUntil.value = 0
    if (traceAutoHideTimer) {
      clearTimeout(traceAutoHideTimer)
      traceAutoHideTimer = undefined
    }
  }
})

// AgentComposer 的 3 个 DOM ref 桥接回 useAgentDialogOptions（selectCommand / commandMenuStyle 等依赖）。
const editorRefFn = (el: HTMLElement | null) => {
  editorRef.value = el
}
const commandMenuRefFn = (el: HTMLElement | null) => {
  commandMenuRef.value = el
}
const roleMenuRefFn = (el: HTMLElement | null) => {
  roleMenuRef.value = el
}

function selectQuickTarget(selection: QuickTargetSelection): void {
  if (quickTarget.value?.source === 'user' && selection.source === 'ai') return
  quickTarget.value = selection
}

async function sendFromComposer(): Promise<void> {
  if (!text.value.trim() || sending.value || quickRoutingPending.value) return
  let targetSelection = quickTarget.value
  if (quickTargetRequired.value && targetSelection?.source !== 'user') {
    if (!quickRoutingEnabled.value || !quickAutoMode.value) {
      error.value = '请选择消息指向的目标后继续'
      return
    }
    error.value = null
    targetSelection = await targetPickerRef.value?.routeForSend(text.value)
    if (!targetSelection) {
      error.value = 'AI 未确定发送目标，请手动选择后重试'
      return
    }
  }
  let targetChatId = chatId.value ?? undefined
  if (quickTargetRequired.value) {
    if (targetSelection?.target === 'new') {
      if (!presetName.value) {
        error.value = '当前 Pet 没有关联预设'
        return
      }
      try {
        targetChatId = await agents.createMasterPet({ preset: presetName.value })
        // 'new' 是一次性目标：会话已创建即消费完毕。残留会让发送失败重试 / 下次发送
        // 再建一个新会话（本次 targetChatId 已捕获在局部变量，清空不影响本条发送）。
        quickTarget.value = undefined
        await agents.fetchHistoryList()
      } catch (cause) {
        console.error('[AgentDialog] create target session failed:', cause)
        error.value = '新建会话失败，请重试或选择一个历史会话'
        return
      }
    } else {
      targetChatId = targetSelection?.target
    }
  }
  if (targetChatId) {
    agents.activatePresetSession(quickPresetId.value, targetChatId, presetName.value)
  }
  // 发送后保持窗口打开（不关闭），路由小窗展示 Shadow Agent 工作流程。
  await handleSend(targetChatId, { keepOpen: true })
}

/** 打开当前会话的节点树工作台（WorkbenchDialog 多窗口，windowId = presetId）。 */
function openWorkbenchForChat(): void {
  const preset = quickPresetId.value
  if (!preset) return
  const presetName = quickPresetName.value
  // desktop surface：工作台由 Electron 原生独立窗承载（每预设一窗）；浏览器保持应用内多窗口
  const bridge = desktopBridge()
  if (bridge) {
    bridge.openWindow({
      kind: 'workbench',
      presetId: preset,
      presetName,
      chatId: chatId.value ?? undefined,
      returnToComposer: agents.activeDialogSource === 'pet',
    })
    return
  }
  const id = agents.openWorkbenchWindow(preset, presetName)
  if (chatId.value) agents.setWorkbenchWindowChat(id, chatId.value)
}

/** 从待处理抽屉 @tree 打开某会话的节点树工作台。 */
async function openWorkspaceTree(
  rootChatId: string,
  sourceChatId?: string,
  interactionId?: string,
  anchorNodeId?: string,
): Promise<void> {
  const preset = quickPresetId.value
  if (!preset) return
  const presetName = quickPresetName.value
  // desktop surface：工作台渲染在另一原生窗（本 renderer 不承载），必须经 main 建窗/聚焦并下发焦点定位
  const bridge = desktopBridge()
  if (bridge) {
    bridge.openWindow({
      kind: 'workbench',
      presetId: preset,
      presetName,
      chatId: rootChatId,
      returnToComposer: agents.activeDialogSource === 'pet',
      focus: { sourceChatId, interactionId, anchorNodeId },
    })
    return
  }
  const id = agents.openWorkbenchWindow(preset, presetName)
  agents.setWorkbenchWindowChat(id, rootChatId)
  agents.setWorkbenchWindowFocus(id, {
    sourceChatId,
    interactionId,
    anchorNodeId,
  })
}

function closeDialog(): void {
  if (props.native) {
    desktopBridge()?.windowControl('close')
    return
  }
  agents.closeAllHistory()
  closeAgentDialog()
}

/** 待处理交互视图切换（非 native 面由 dialog-head 内按钮触发；native 面经 defineExpose 由 WindowFrame title-actions 调用）。 */
function toggleAttention(): void {
  dialogView.value = dialogView.value === 'attention' ? 'composer' : 'attention'
}

function onDialogEditorKeydown(e: KeyboardEvent): void {
  onEditorKeydown(e, () => void sendFromComposer())
}

// ── 斜杠指令菜单定位（Teleport 到 body 后用 fixed 定位；锚定 .msg-input 顶部，向上展开） ──
const commandMenuStyle = reactive({
  zIndex: OVERLAY_Z_INDEX.composerMenu,
  bottom: '0px',
  left: '0px',
  width: '390px',
  maxHeight: '280px',
})
function positionCommandMenu(): void {
  const editor = editorRef.value
  const menu = commandMenuRef.value ?? roleMenuRef.value
  if (!editor || !menu) return
  const editorRect = editor.getBoundingClientRect()
  const margin = 8
  const minWidth = 280
  const maxWidth = Math.min(420, window.innerWidth - margin * 2)
  const width = Math.max(minWidth, Math.min(maxWidth, editorRect.width))
  const left = Math.max(margin, Math.min(editorRect.left, window.innerWidth - width - margin))
  // 菜单底边固定在输入框上沿 6px；内容/Tab 高度变化时只向上伸缩。
  commandMenuStyle.bottom = `${window.innerHeight - editorRect.top + 6}px`
  commandMenuStyle.left = `${left}px`
  commandMenuStyle.width = `${width}px`
  commandMenuStyle.maxHeight = `${Math.min(280, Math.max(0, editorRect.top - margin - 6))}px`
}
watch(showCommandMenu, async (open) => {
  if (open) {
    await nextTick()
    positionCommandMenu()
  }
})
watch(showRoleMenu, async (open) => {
  if (open) {
    await nextTick()
    positionCommandMenu()
  }
})
watch(activeCommandIndex, () => {
  // 高亮项滚动进视口后再校准菜单位置（菜单高度变化时）
  if (showCommandMenu.value) {
    nextTick(() => positionCommandMenu())
  }
})
watch([activeCommandTab, commandOptions], () => {
  if (showCommandMenu.value) nextTick(() => positionCommandMenu())
})
if (typeof window !== 'undefined') {
  window.addEventListener('resize', positionCommandMenu)
  window.addEventListener('scroll', positionCommandMenu, true)
}
onBeforeUnmount(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', positionCommandMenu)
    window.removeEventListener('scroll', positionCommandMenu, true)
    window.removeEventListener('pointermove', onPanelPointerMove)
    window.removeEventListener('pointerup', onPanelPointerUp)
  }
  if (traceAutoHideTimer) clearTimeout(traceAutoHideTimer)
})

/** 颜色分级（与 SessionList / HistoryDrawerPanel / ContextBar 对齐：<50% 绿 / 50-80% 黄 / >=80% 红）。 */
function usageClass(u: number): 'usage-low' | 'usage-mid' | 'usage-high' {
  if (u >= 0.8) return 'usage-high'
  if (u >= 0.5) return 'usage-mid'
  return 'usage-low'
}

/** 每角色上下文占用（按当前 brain 的 contextLimit 折算）。brain / config / pet 任一未就绪 → null（chip 隐藏）。 */
const roleUsages = computed<Record<string, { used: number; total: number; usage: number } | null>>(
  () => {
    const p = pet.value
    const out: Record<string, { used: number; total: number; usage: number } | null> = {}
    for (const [role, sel] of Object.entries(roleSelections.value)) {
      const limit = brainConfig(sel.brain)?.contextLimit
      if (!limit || !p) {
        out[role] = null
        continue
      }
      const used = p.contextUsed ?? 0
      const usage = Math.min(1, Math.max(0, used / limit))
      out[role] = { used, total: limit, usage }
    }
    return out
  },
)

/** dialog-head 工作区模式：workspace 有值时 pet name 前 📁（路径失效改 ⚠ 红色），hover 显全路径。无 workspace 纯文本。 */
const workspaceInvalid = computed(() => pet.value?.workspaceValid === false)

// native 面（Electron composer 原生窗，WindowFrame 外壳）：AgentDialog 自绘标题栏隐藏，
// 标题 / 能力按钮 / 三键全部由 WindowFrame 承载。能力按钮经 title-actions slot 渲染，
// 操作与状态经此暴露给 App.vue（🌳 节点树 / ! 待处理交互）。计数与视图态用函数返回
// 响应式值（App.vue 以 computed 包装读取，保持追踪）。
defineExpose({
  openWorkbenchForChat,
  openWorkspaceTree,
  closeDialog,
  toggleAttention,
  getWorkspaceAttentionCount: () => workspaceAttentionCount.value,
  isAttentionView: () => dialogView.value === 'attention',
})
</script>

<template>
  <AnimatePresence>
    <MotionDiv
      v-if="dialogVisible"
      key="overlay"
      class="dialog-overlay"
      :class="{ 'is-top-mask': isTopMask, 'is-floating': isFloatingOverlay, 'is-native': native }"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: 1 }"
      :exit="{ opacity: 0 }"
      :transition="{ duration: 0.16 }"
    >
      <!-- 快速发送 composer 弹窗 panel（header + 角色编制 + composer + 待处理抽屉） -->
      <MotionDiv
        key="panel"
        :ref="bindPanelEl"
        class="dialog-panel"
        data-desktop-hit
        :style="panelStyle"
        :initial="{ opacity: 0, y: 16, scale: 0.96 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: 12, scale: 0.97 }"
        :transition="{ duration: 0.18, ease: 'easeOut' }"
        role="dialog"
        aria-modal="true"
        :aria-label="`向 ${pet?.name ?? '智能体'} 发送消息`"
      >
        <header v-if="!native" class="dialog-head" @pointerdown="onHeaderPointerDown">
          <span class="title">
            <span class="title-row">
              <el-tooltip
                v-if="pet?.workspace"
                placement="bottom"
                :show-after="200"
                :hide-after="0"
              >
                <template #content>
                  <span>工作区：{{ pet.workspace }}</span>
                  <span v-if="workspaceInvalid" style="color: #fca5a5"> · 路径失效</span>
                </template>
                <span class="who" :class="{ 'is-ws-invalid': workspaceInvalid }">
                  <span class="who-icon">{{ workspaceInvalid ? '⚠' : '📁' }}</span
                  >{{ pet?.name ?? presetName ?? 'agent' }}
                </span>
              </el-tooltip>
              <span v-else class="who">{{ pet?.name ?? presetName ?? 'agent' }}</span>
            </span>
            <span class="hint">Cmd/Ctrl+Enter 发送 · Esc 关闭</span>
          </span>
          <div class="head-actions">
            <el-tooltip placement="bottom" :show-after="120" :hide-after="0">
              <template #content>
                <span>打开当前会话的节点树工作台</span>
              </template>
              <button
                type="button"
                class="history-keys-btn"
                :class="{ 'is-active': dialogView === 'tree' }"
                aria-label="打开当前会话节点树工作台"
                @click="openWorkbenchForChat"
              >
                🌳
              </button>
            </el-tooltip>
            <el-tooltip placement="bottom" :show-after="120" :hide-after="0">
              <template #content>
                <span>待处理交互（审批 / 提问）</span>
              </template>
              <button
                type="button"
                class="history-keys-btn attention-head-btn"
                :class="{ 'is-active': dialogView === 'attention' }"
                aria-label="待处理交互"
                :aria-pressed="dialogView === 'attention'"
                @click="toggleAttention"
              >
                !<b v-if="workspaceAttentionCount">{{ workspaceAttentionCount }}</b>
              </button>
            </el-tooltip>
            <button type="button" class="close-btn" aria-label="关闭" @click="closeDialog">
              ✕
            </button>
          </div>
        </header>

        <WorkspaceSessionBrowser
          v-show="dialogView === 'attention'"
          :preset-id="quickPresetId"
          :native="native"
          @tree="openWorkspaceTree"
        />

        <div v-show="dialogView !== 'attention'" class="dialog-composer-content">
          <div class="role-configs">
            <div class="session-note">小组角色编制</div>
            <div
              v-if="loading"
              class="role-tags role-tags-skel"
              aria-busy="true"
              aria-label="角色编制加载中"
            >
              <span v-for="n in 3" :key="n" class="role-skel-tile" aria-hidden="true" />
            </div>
            <div v-else class="role-tags" aria-label="小组角色编制">
              <el-popover
                v-for="[role, selection] in orderedRoleSelections"
                :key="role"
                trigger="click"
                placement="bottom-start"
                :width="420"
                popper-class="role-runtime-popper"
              >
                <template #reference>
                  <button
                    type="button"
                    class="role-summary-tag"
                    :class="{ 'is-primary': role === primaryRole }"
                    :aria-label="`配置角色 ${role}，大脑 ${selection.brain || '未选择'}，${senseEntries(selection.senseGroup).length} 项能力`"
                  >
                    <span class="role-summary-main">
                      <span aria-hidden="true">{{ role === primaryRole ? '♛' : '✦' }}</span>
                      <span class="role-summary-name">{{ role }}</span>
                    </span>
                    <span class="role-summary-meta-row">
                      <span class="role-summary-model-slot">
                        <span class="role-summary-model">◈ {{ selection.brain || '—' }}</span>
                      </span>
                      <el-tooltip
                        v-if="roleUsages[role]"
                        placement="top"
                        :show-after="200"
                        :hide-after="0"
                      >
                        <template #content>
                          <ContextBreakdownTip
                            v-if="pet?.contextBreakdown"
                            :breakdown="pet.contextBreakdown"
                          />
                          <span v-else
                            >上下文 {{ Math.round(roleUsages[role]!.usage * 100) }}%</span
                          >
                        </template>
                        <span
                          class="role-usage-chip"
                          :class="usageClass(roleUsages[role]!.usage)"
                          :aria-label="`上下文 ${Math.round(roleUsages[role]!.usage * 100)}% · ${fmtTokens(roleUsages[role]!.used)} / ${fmtTokens(roleUsages[role]!.total)}`"
                          >{{ fmtTokens(roleUsages[role]!.used) }}/{{
                            fmtTokens(roleUsages[role]!.total)
                          }}</span
                        >
                      </el-tooltip>
                    </span>
                    <span
                      v-if="senseEntries(selection.senseGroup).length"
                      class="role-summary-senses"
                      aria-label="当前能力"
                    >
                      <span
                        v-for="entry in senseEntries(selection.senseGroup)"
                        :key="entry"
                        class="role-summary-sense-icon"
                      >
                        {{ senseTool(entry)?.icon ?? '⚙' }}
                      </span>
                    </span>
                  </button>
                </template>

                <RoleConfigPopover
                  :role="role"
                  :selection="selection"
                  :brains="brains"
                  :sense-groups="senseGroups"
                  :config="config"
                  :sense-tools="senseTools"
                  :is-primary="role === primaryRole"
                  :primary-role="primaryRole"
                  @update:selection="roleSelections[role] = $event"
                />
              </el-popover>
            </div>
          </div>

          <ConversationTargetPicker
            v-if="quickTargetRequired && quickPresetId"
            ref="targetPickerRef"
            :preset-id="quickPresetId"
            :sessions="quickSessions"
            :selected="quickTarget?.target"
            :selected-source="quickTarget?.source"
            :routing-enabled="quickRoutingEnabled"
            @select="selectQuickTarget"
            @clear-ai="clearAiQuickTarget"
            @clear-target="quickTarget = undefined"
            @enable-auto="enableAiQuickTarget"
            @routing-change="setQuickRoutingPending"
            @auto-mode-change="quickAutoMode = $event"
            @ai-status-hover="onTraceHover(true)"
            @ai-status-leave="onTraceHover(false)"
            @route-status="onRouteStatus"
          />

          <AgentComposer
            :is-nyxus="false"
            :nyxus-draft-active="false"
            :sending="sending || quickRoutingPending"
            :loading="loading"
            :text="text"
            :error="error"
            :media-attachments="mediaAttachments"
            :media-hint="mediaHint"
            :uploading="uploading"
            :primary-selection="primarySelection"
            :supports-tools="supportsTools"
            :media-services-by-type="mediaServicesByType"
            :command-options="commandOptions"
            :command-tabs="commandTabs"
            :active-command-tab="activeCommandTab"
            :combo-command-groups="comboCommandGroups"
            :show-command-menu="showCommandMenu"
            :command-menu-style="commandMenuStyle"
            :active-command-index="activeCommandIndex"
            :show-role-menu="showRoleMenu"
            :matching-role-mentions="matchingRoleMentions"
            :active-role-index="activeRoleIndex"
            :editor-ref-fn="editorRefFn"
            :command-menu-ref-fn="commandMenuRefFn"
            :role-menu-ref-fn="roleMenuRefFn"
            @remove-media="removeMedia"
            @editor-input="onEditorInput"
            @editor-keydown="onDialogEditorKeydown"
            @editor-selection-change="onEditorSelectionChange"
            @editor-paste="onEditorPaste"
            @select-command="selectCommand"
            @select-command-tab="selectCommandTab"
            @select-role-mention="selectRoleMention"
            @media-selected="(f: any) => onMediaSelected(f)"
            @send="sendFromComposer"
            @update:active-command-index="activeCommandIndex = $event"
            @update:active-role-index="activeRoleIndex = $event"
          />
        </div>
      </MotionDiv>

      <!-- 拖拽占位框：拖动中仅此边框跟随鼠标（transform 驱动），松开后面板整体瞬移到位 -->
      <div
        v-if="dragPreview"
        class="dialog-drag-preview"
        :style="dragPreviewStyle"
        aria-hidden="true"
      />

      <!-- 会话路由小窗：锚定在发送面板右侧，展示 Shadow Agent 工作流程（候选+选择+思考/正文） -->
      <RoutingTraceWindow
        v-if="showTraceWindow"
        :pos="traceWindowPos"
        :routing="routeStatus.routing"
        :trace="routeStatus.trace"
        :thinking="routeStatus.thinking"
        :content="routeStatus.content"
      />
    </MotionDiv>
  </AnimatePresence>
</template>

<style scoped lang="less">
@import '../dialog/agentDialog.less';

/* 拖拽占位框：拖动中只显示此边框，尺寸在 pointerdown 时记录一次；松开后 panel 瞬移，本框消失。 */
.dialog-drag-preview {
  z-index: 2;
  border: 1.5px dashed color-mix(in srgb, var(--accent) 65%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--accent) 5%, transparent);
  pointer-events: none;
  will-change: transform;
}

.role-usage-chip {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  line-height: 1.4;
}
.role-usage-chip.usage-low {
  background: rgba(34, 197, 94, 0.14);
  color: #16a34a;
}
.role-usage-chip.usage-mid {
  background: rgba(234, 179, 8, 0.16);
  color: #a16207;
}
.role-usage-chip.usage-high {
  background: rgba(239, 68, 68, 0.16);
  color: #b91c1c;
}
.role-summary-meta-row {
  display: inline-flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
  max-width: 100%;
}
.history-keys-btn {
  width: 30px;
  height: 30px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  margin-right: 6px;
}
.history-keys-btn.is-active {
  border-color: #7c3aed;
  color: #6d28d9;
  background: rgba(124, 58, 237, 0.1);
}
.attention-head-btn {
  position: relative;
}
.attention-head-btn b {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  border-radius: 999px;
  background: #dc2626;
  color: #fff;
  font-size: 8px;
  line-height: 15px;
}
</style>

<style lang="less">
.dialog-overlay.is-native {
  // 铺满 WindowFrame body（position:relative），不盖标题栏；绝对定位避免 fixed 覆盖整个 viewport。
  // 保持 flex（对齐 settings/workbench native 先例：仅 center→stretch）——display:block 会摧毁
  // 内部 flex 布局链，导致 .dialog-composer-content（角色编制/发送区）塌缩不可见。
  position: absolute;
  inset: 0;
  display: flex;
  align-items: stretch;
  padding: 0;
  background: transparent;
  backdrop-filter: none;
  overflow: hidden;
  // pet 来源 activeDialogSource==='pet' → isFloatingOverlay=true → .dialog-overlay.is-floating
  // 置 pointer-events:none（scoped 带 [data-v-x] 优先级更高）。native 整窗铺满必须可点，
  // 复合选择器抬升优先级并晚声明，确保覆盖。
  pointer-events: auto;
  &.is-floating {
    pointer-events: auto;
  }

  .dialog-panel {
    position: relative !important;
    left: auto !important;
    top: auto !important;
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    margin: 0 !important;
    border: 0;
    border-radius: 0;
    box-shadow: none;
    // 与 WindowFrame 统一：内容区底色 --bg（标题栏 --panel 对比清晰），panel 卡片底色让位
    background: var(--bg);
  }

  // 发送内容区铺满剩余空间（角色编制在上、发送区占满），超高时内部滚动
  .dialog-composer-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

}
</style>

<!-- Popover 挂载到 Teleport 根节点，需用非 scoped 样式去除 Element Plus 的外层壳。 -->
<style lang="less">
.role-runtime-popper.el-popper {
  --el-popover-border-color: transparent;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.role-runtime-popper .el-popper__arrow {
  display: none;
}

.add-media-popper.el-popover {
  border-radius: 10px;
}

.add-media-menu {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.add-media-upload {
  width: 100%;

  .el-upload {
    width: 100%;
    display: block;
  }
}

.add-media-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 7px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 400;
  color: var(--ink);
  transition: background-color 100ms ease;

  &:hover {
    background: rgba(246, 183, 60, 0.12);
  }

  span:first-child {
    font-size: 14px;
  }
}

.media-svc-tag {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(246, 183, 60, 0.15);
  color: #9a7422;
  &.missing {
    background: rgba(180, 30, 30, 0.08);
    color: #b04040;
  }
}

// 指令卡片由富文本编辑器在 hover 时挂到 body，避免被输入框和弹窗滚动容器裁剪。
.instruction-token-floating-popover {
  position: fixed;
  z-index: 320;
  display: flex;
  flex-direction: column;
  gap: 5px;
  width: 248px;
  padding: 8px 9px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface-hover);
  box-shadow: 0 7px 18px rgba(20, 22, 26, 0.18);
  color: var(--ink);
  font-size: 10.5px;
  font-weight: 400;
  line-height: 1.45;
  pointer-events: none;
}

.instruction-token-floating-title {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  font-weight: 600;
}

.instruction-token-floating-description {
  color: color-mix(in srgb, var(--ink) 76%, transparent);
}

.instruction-token-floating-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 5px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  color: var(--accent-ink);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  font-weight: 400;
}
</style>
