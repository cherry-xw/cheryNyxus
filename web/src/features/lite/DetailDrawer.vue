<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useLiteStore } from './liteStore'
import { useLiteCanonicalView } from './useLiteCanonicalView'
import {
  classifyToolType,
  formatElapsed,
  toolTypeGlyph,
  toolTypeLabel,
  type LiteRunNode,
  type LiteRunNodeKind,
  type LiteRunNodeStatus,
} from './executionMonitor'
import {
  createLiteDetailSectionState,
  mergeDetailSectionPage,
  type LiteDetailSectionName,
} from './detailSections'
import LiteMarkdown from './LiteMarkdown.vue'
import LiteToolCallDetail from './LiteToolCallDetail.vue'

/**
 * DetailDrawer：单个节点的详情抽屉（需求 3：点击详情只展示该节点本身的信息，
 * 思考/正文/工具调用 全部列出，不做成三个折叠区块）。
 * - 带半透明遮罩：点击遮罩即可关闭（需求：抽屉没有遮罩、点周围关不掉的问题）。
 * - 不含轨迹时间线（轨迹已上移到页面顶部，见 LiteView）。
 */
const props = defineProps<{
  windowId: string
  rootChatId: string
  /** 当前展示的节点（null 时不渲染）。只展示这一个节点，而非全部节点列表。 */
  node: LiteRunNode | null | undefined
  nodeIndex?: number
  focusToolCallId?: string | null
  initialSection?: LiteDetailSectionName | null
}>()
const emit = defineEmits<{ close: [] }>()

const liteUi = useLiteStore()
const lite = useLiteCanonicalView(
  () => props.windowId,
  () => props.rootChatId,
)
const dialogRef = ref<HTMLElement | null>(null)
const bodyRef = ref<HTMLElement | null>(null)
const closeButtonRef = ref<HTMLButtonElement | null>(null)
const loadingNodeIds = ref<Record<string, boolean>>({})
const sectionLoading = ref<Record<string, boolean>>({})
// 数据放宽（需求：适当放宽一次响应回来的内容数据量；其余交互不放开）
const DETAIL_PAGE_LIMIT = 30000

// ── v1.2 抽屉宽度可拖拽：左缘手柄横向拖拽，宽度 clamp(320px, 拖拽值, 92% 容器)，
// 拖拽中走本地 ref（不逐帧打 store），松手时持久化到 rootUi（按窗口 × 会话记忆）。 ──
const DRAWER_MIN_WIDTH = 320
const DRAWER_DEFAULT_WIDTH = 460
const drawerLayerRef = ref<HTMLElement | null>(null)
const dragWidth = ref<number | null>(null)
const resizing = ref(false)
const savedDrawerWidth = computed<number | null>(
  () => liteUi.rootUi(props.windowId, props.rootChatId)?.detailDrawerWidth ?? null,
)
const drawerStyle = computed(() => {
  const width = dragWidth.value ?? savedDrawerWidth.value
  return width ? { width: width + 'px' } : undefined
})
function onResizeStart(event: PointerEvent): void {
  const layer = drawerLayerRef.value
  const handle = event.currentTarget
  if (!layer || !(handle instanceof HTMLElement) || event.button !== 0) return
  const startX = event.clientX
  const startWidth =
    savedDrawerWidth.value ?? Math.min(DRAWER_DEFAULT_WIDTH, Math.floor(layer.clientWidth * 0.92))
  const maxWidth = Math.max(DRAWER_MIN_WIDTH, Math.floor(layer.clientWidth * 0.92))
  resizing.value = true
  handle.setPointerCapture(event.pointerId)
  const onMove = (move: PointerEvent): void => {
    dragWidth.value = Math.min(
      maxWidth,
      Math.max(DRAWER_MIN_WIDTH, startWidth + (startX - move.clientX)),
    )
  }
  const onEnd = (): void => {
    resizing.value = false
    handle.removeEventListener('pointermove', onMove)
    handle.removeEventListener('pointerup', onEnd)
    handle.removeEventListener('pointercancel', onEnd)
    if (dragWidth.value !== null) {
      liteUi.patchRootUi(props.windowId, props.rootChatId, { detailDrawerWidth: dragWidth.value })
      dragWidth.value = null
    }
  }
  handle.addEventListener('pointermove', onMove)
  handle.addEventListener('pointerup', onEnd)
  handle.addEventListener('pointercancel', onEnd)
}

function runStatusLabel(status: LiteRunNodeStatus): string {
  switch (status) {
    case 'running':
      return '执行中'
    case 'completed':
      return '已完成'
    case 'failed':
      return '失败'
    case 'rejected':
      return '已拒绝'
    case 'cancelled':
      return '已取消'
  }
}
function kindLabel(kind: LiteRunNodeKind): string {
  switch (kind) {
    case 'user':
      return '用户消息'
    case 'root-agent':
      return '主 Agent 响应'
    case 'child-agent':
      return '子 Agent 响应'
    case 'tool':
      return '工具节点'
    case 'return':
      return '结果返回'
    case 'dispatch':
      return '任务委派'
    case 'spawn':
      return '创建协作节点'
    case 'system':
      return '系统事件'
  }
}
function toolLabel(call: { name: string }): string {
  return lite.toolMeta(call.name)?.label?.trim() || call.name
}
function toolIcon(call: { name: string }): string {
  return toolTypeGlyph(classifyToolType(call.name))
}

/** 按节点类型列出要展示的详情分节：用户→正文；工具→工具调用；主·子 Agent→思考+正文；其余事件→正文。 */
const sections = computed<LiteDetailSectionName[]>(() => {
  if (!props.node) return []
  if (props.node.kind === 'user') return ['content']
  if (props.node.kind === 'tool') return ['toolCalls']
  if (props.node.kind === 'root-agent' || props.node.kind === 'child-agent') {
    return ['thinking', 'content']
  }
  return ['content']
})

function detailState(section: LiteDetailSectionName) {
  if (!props.node) return createLiteDetailSectionState()
  const cache = liteUi.rootUi(props.windowId, props.rootChatId)?.detailCache[props.node.nodeId]
  return cache ? cache[section] : createLiteDetailSectionState()
}
function sectionLoaded(section: LiteDetailSectionName): boolean {
  return detailState(section).loaded
}
function sectionError(section: LiteDetailSectionName): string | null {
  return detailState(section).error
}
function sectionText(section: 'thinking' | 'content'): string {
  return detailState(section).text
}
function sectionHasMore(section: LiteDetailSectionName): boolean {
  return detailState(section).hasMore
}
function sectionToolCalls() {
  return detailState('toolCalls').toolCalls
}
function isSectionLoading(section: LiteDetailSectionName): boolean {
  return sectionLoading.value[`${props.node?.nodeId}:${section}`] ?? false
}
function isLoadingNode(): boolean {
  return props.node ? (loadingNodeIds.value[props.node.nodeId] ?? false) : false
}

async function loadSection(section: LiteDetailSectionName): Promise<void> {
  const nodeId = props.node?.nodeId
  if (!nodeId) return
  const requestKey = `${nodeId}:${section}`
  if (sectionLoading.value[requestKey]) return
  const state = detailState(section)
  if (state.loaded && !state.hasMore) return
  // The Lite projection already contains complete content for ordinary
  // conversation/event nodes. Asking the execution-node endpoint for those
  // source-message ids produces a false "invalid data" error.
  if (section === 'content' && !state.loaded && props.node?.kind !== 'tool') {
    liteUi.patchDetailSection(props.windowId, props.rootChatId, nodeId, section, {
      ...state,
      loaded: true,
      text: props.node.content,
      offset: props.node.content.length,
      error: null,
    })
    return
  }
  const requestedOffset = state.loaded ? state.offset : 0
  sectionLoading.value[requestKey] = true
  try {
    const response = await lite.fetchNodeDetail(nodeId, {
      sections: [section],
      ...(section === 'toolCalls'
        ? {
            toolCursor: state.toolCursor ?? {
              callIndex: 0,
              field: 'arguments' as const,
              offset: 0,
            },
          }
        : { offset: requestedOffset }),
      limit: DETAIL_PAGE_LIMIT,
    })
    if (!response.success) {
      liteUi.patchDetailSection(props.windowId, props.rootChatId, nodeId, section, {
        ...state,
        error: response.error.message,
      })
      return
    }
    liteUi.patchDetailSection(
      props.windowId,
      props.rootChatId,
      nodeId,
      section,
      mergeDetailSectionPage(state, section, response.data, requestedOffset, DETAIL_PAGE_LIMIT),
    )
  } finally {
    sectionLoading.value[requestKey] = false
  }
}

async function loadNodeSections(): Promise<void> {
  if (!props.node) return
  loadingNodeIds.value[props.node.nodeId] = true
  try {
    await Promise.all(sections.value.map((section) => loadSection(section)))
  } finally {
    loadingNodeIds.value[props.node.nodeId] = false
  }
}

function requestClose(): void {
  emit('close')
}

// ── 焦点管理 ──
function focusableElements(): HTMLElement[] {
  if (!dialogRef.value) return []
  return [
    ...dialogRef.value.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ),
  ].filter((element) => !element.hasAttribute('hidden'))
}

function onDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }
  if (event.key !== 'Tab') return
  const focusable = focusableElements()
  if (!focusable.length) {
    event.preventDefault()
    dialogRef.value?.focus()
    return
  }
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last?.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first?.focus()
  }
}

watch(
  () => [props.windowId, props.rootChatId, props.node?.nodeId, props.initialSection] as const,
  async ([, , nodeId, initialSection], previous) => {
    if (!nodeId) return
    const isNewNode =
      nodeId !== previous?.[2] ||
      props.windowId !== previous?.[0] ||
      props.rootChatId !== previous?.[1]
    await nextTick()
    closeButtonRef.value?.focus()
    if (bodyRef.value) bodyRef.value.scrollTop = 0
    if (isNewNode) loadNodeSections()
    else if (initialSection) {
      // 审批等带初始工具详情的入口：保证目标分节已加载
      const state = detailState(initialSection)
      if (!state.loaded) await loadSection(initialSection)
    }
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="props.node" ref="drawerLayerRef" class="lite-drawer-layer" :class="{ 'is-resizing': resizing }">
    <div class="lite-drawer-mask" aria-hidden="true" @click="requestClose" />
    <aside
      ref="dialogRef"
      class="lite-drawer"
      :style="drawerStyle"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lite-detail-title"
      tabindex="-1"
      @keydown="onDialogKeydown"
    >
      <!-- v1.2：左缘拖拽手柄——横向拖拽调整抽屉宽度 -->
      <div class="lite-drawer-resize" aria-hidden="true" @pointerdown="onResizeStart" />
      <header class="lite-drawer-head">
        <span class="lite-drawer-icon" aria-hidden="true">{{ props.node.icon }}</span>
        <strong id="lite-detail-title">{{ props.node.label }}</strong>
        <span class="lite-drawer-status" :data-status="props.node.status">{{
          runStatusLabel(props.node.status)
        }}</span>
        <span
          v-if="props.node.kind === 'tool'"
          class="lite-drawer-type"
          :data-tooltype="props.node.toolType"
          :title="'工具类型：' + toolTypeLabel(props.node.toolType)"
          >{{ toolTypeGlyph(props.node.toolType) }} {{ toolTypeLabel(props.node.toolType) }}</span
        >
        <time v-if="props.node.elapsedMs > 0" class="lite-drawer-elapsed">{{
          formatElapsed(props.node.elapsedMs)
        }}</time>
        <span class="lite-drawer-meta"
          >{{ kindLabel(props.node.kind)
          }}{{ nodeIndex !== undefined ? ' · 节点 ' + (nodeIndex + 1) : '' }}</span
        >
        <button
          ref="closeButtonRef"
          type="button"
          class="lite-drawer-close"
          aria-label="关闭详情"
          @click="requestClose"
        >
          ✕
        </button>
      </header>

      <div ref="bodyRef" class="lite-drawer-body">
        <p v-if="isLoadingNode()" class="lite-drawer-hint">加载节点内容…</p>
        <template v-else>
          <section v-if="sections.includes('thinking')" class="lite-node-detail-block">
            <h4>思考</h4>
            <p v-if="sectionError('thinking')" class="lite-drawer-error" role="alert">
              {{ sectionError('thinking') }}
            </p>
            <template v-else>
              <p v-if="!sectionLoaded('thinking')" class="lite-drawer-hint is-muted">加载中…</p>
              <template v-else-if="sectionText('thinking')">
                <LiteMarkdown :text="sectionText('thinking')" />
                <button
                  v-if="sectionHasMore('thinking')"
                  type="button"
                  class="lite-drawer-more"
                  :disabled="isSectionLoading('thinking')"
                  @click="loadSection('thinking')"
                >
                  加载更多思考
                </button>
              </template>
              <p v-else class="lite-drawer-hint is-muted">（无思考内容）</p>
            </template>
          </section>

          <section v-if="sections.includes('content')" class="lite-node-detail-block">
            <h4>正文</h4>
            <p v-if="sectionError('content')" class="lite-drawer-error" role="alert">
              {{ sectionError('content') }}
            </p>
            <template v-else>
              <p v-if="!sectionLoaded('content')" class="lite-drawer-hint is-muted">加载中…</p>
              <template v-else-if="sectionText('content')">
                <LiteMarkdown :text="sectionText('content')" :plain="props.node.kind === 'user'" />
                <button
                  v-if="sectionHasMore('content')"
                  type="button"
                  class="lite-drawer-more"
                  :disabled="isSectionLoading('content')"
                  @click="loadSection('content')"
                >
                  加载更多正文
                </button>
              </template>
              <p v-else class="lite-drawer-hint is-muted">（无正文内容）</p>
            </template>
          </section>

          <section v-if="sections.includes('toolCalls')" class="lite-node-detail-block">
            <h4>工具调用</h4>
            <p v-if="sectionError('toolCalls')" class="lite-drawer-error" role="alert">
              {{ sectionError('toolCalls') }}
            </p>
            <template v-else>
              <p v-if="!sectionLoaded('toolCalls')" class="lite-drawer-hint is-muted">加载中…</p>
              <template v-else-if="sectionToolCalls().length">
                <!-- 专用渲染：按工具类型解析参数 / 结果（命令、路径、URL、任务说明…）+ JSON 键中文翻译 -->
                <LiteToolCallDetail
                  v-for="call in sectionToolCalls()"
                  :key="call.callId"
                  :call="call"
                  :label="toolLabel(call)"
                  :icon="toolIcon(call)"
                  :type="classifyToolType(call.name)"
                  :focused="call.callId === props.focusToolCallId"
                />
                <button
                  v-if="sectionHasMore('toolCalls')"
                  type="button"
                  class="lite-drawer-more"
                  :disabled="isSectionLoading('toolCalls')"
                  @click="loadSection('toolCalls')"
                >
                  加载更多工具
                </button>
              </template>
              <p v-else class="lite-drawer-hint is-muted">（无工具调用）</p>
            </template>
          </section>
        </template>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.lite-drawer-layer {
  position: absolute;
  inset: 0;
  z-index: 30;
}
.lite-drawer-mask {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, #0b0b0f 42%, transparent);
}
.lite-drawer-layer.is-resizing {
  cursor: ew-resize;
  user-select: none;
}
.lite-drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(460px, 92%);
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
  border-left: 1px solid var(--el-border-color);
  box-shadow: -10px 0 28px rgba(0, 0, 0, 0.18);
  outline: none;
  color: var(--el-text-color-primary);
}
/* v1.2：左缘拖拽手柄（ew-resize），hover 主色提示可拖拽 */
.lite-drawer-resize {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -3px;
  width: 6px;
  cursor: ew-resize;
  z-index: 2;
}
.lite-drawer-resize:hover {
  background: color-mix(in srgb, var(--el-color-primary) 24%, transparent);
}
.lite-drawer-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex: none;
}
.lite-drawer-icon {
  font-size: 15px;
  line-height: 1;
}
.lite-drawer-head strong {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 150px;
  /* 强制字重规则：lite 内容一律 400，标题亦收敛（不随 <strong> 默认加粗）。 */
  font-weight: 400;
}
.lite-drawer-status {
  flex: none;
  padding: 0 7px;
  border-radius: 0;
  border: 1px solid var(--el-border-color);
  font-size: 10.5px;
  line-height: 16px;
  color: var(--el-text-color-secondary);
}
.lite-drawer-status[data-status='running'] {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}
.lite-drawer-status[data-status='failed'],
.lite-drawer-status[data-status='rejected'] {
  border-color: var(--el-color-danger);
  color: var(--el-color-danger);
}
.lite-drawer-elapsed {
  font-size: 11px;
  color: var(--el-text-color-secondary);
  flex: none;
  font-variant-numeric: tabular-nums;
}
.lite-drawer-meta {
  flex: 1;
  text-align: right;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lite-drawer-close {
  flex: none;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  font-size: 12px;
}
.lite-drawer-close:hover {
  background: var(--el-fill-color-light);
  color: var(--el-text-color-primary);
}
.lite-drawer-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 12px 14px 20px;
  /* v1.2：滚动链隔离 + 恢复主题化细滚动条（工具详情可能超长，纯滚轮太慢） */
  overscroll-behavior: contain;
  scrollbar-width: thin;
  scrollbar-color: var(--el-border-color-darker) transparent;
}
.lite-drawer-body::-webkit-scrollbar {
  width: 8px;
}
.lite-drawer-body::-webkit-scrollbar-track {
  background: transparent;
}
.lite-drawer-body::-webkit-scrollbar-thumb {
  background: var(--el-border-color-darker);
  border: 2px solid transparent;
  background-clip: padding-box;
}
.lite-drawer-body::-webkit-scrollbar-thumb:hover {
  background-color: var(--el-text-color-placeholder);
}
.lite-node-detail-block {
  margin-bottom: 16px;
}
.lite-node-detail-block h4 {
  margin: 0 0 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  font-weight: 400;
  letter-spacing: 0.02em;
}
.lite-drawer-type {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 7px;
  border-radius: 0;
  font-size: 10.5px;
  line-height: 17px;
  border: 1px solid var(--el-border-color);
  color: var(--el-text-color-secondary);
  white-space: nowrap;
}
.lite-drawer-type[data-tooltype='exec'] {
  border-color: color-mix(in srgb, #9b59b6 55%, var(--el-border-color));
  color: #9b59b6;
}
.lite-drawer-type[data-tooltype='read'] {
  border-color: color-mix(in srgb, #6b7f92 55%, var(--el-border-color));
  color: #6b7f92;
}
.lite-drawer-type[data-tooltype='write'] {
  border-color: color-mix(in srgb, #2f9e63 55%, var(--el-border-color));
  color: #2f9e63;
}
.lite-drawer-type[data-tooltype='web'] {
  border-color: color-mix(in srgb, #00a8a8 55%, var(--el-border-color));
  color: #00a8a8;
}
.lite-drawer-type[data-tooltype='dispatch'] {
  border-color: color-mix(in srgb, #e67e22 55%, var(--el-border-color));
  color: #e67e22;
}
.lite-drawer-type[data-tooltype='other'] {
  border-color: color-mix(in srgb, #c58a1f 55%, var(--el-border-color));
  color: #c58a1f;
}
.lite-drawer-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 0;
  background: color-mix(in srgb, var(--el-color-danger) 10%, transparent);
  color: var(--el-color-danger);
  font-size: 12px;
}
.lite-drawer-hint {
  margin: 0;
  padding: 8px 10px;
  border-radius: 0;
  background: var(--el-fill-color-lighter);
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.lite-drawer-hint.is-muted {
  background: transparent;
  padding: 4px 2px;
}
.lite-drawer-more {
  margin-top: 6px;
  padding: 3px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  font-size: 11.5px;
  cursor: pointer;
}
.lite-drawer-more:hover:not(:disabled) {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}
.lite-drawer-more:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
