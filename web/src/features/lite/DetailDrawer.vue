<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useLiteStore } from './liteStore'
import { useLiteCanonicalView } from './useLiteCanonicalView'
import {
  formatElapsed,
  type LiteRunNode,
  type LiteRunNodeKind,
  type LiteRunNodeStatus,
} from './executionMonitor'
import {
  createLiteDetailSectionState,
  mergeDetailSectionPage,
  type LiteDetailSectionName,
} from './detailSections'

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
    case 'model':
      return '模型节点'
    case 'tool':
      return '工具节点'
  }
}
function toolStatusLabel(status: string | undefined): string {
  switch (status) {
    case 'pending':
      return '等待中'
    case 'accepted':
      return '执行中'
    case 'rejected':
      return '已拒绝'
    case 'error':
      return '出错'
    case 'completed':
      return '已完成'
    default:
      return status || '未知'
  }
}
function toolLabel(call: { name: string }): string {
  return lite.toolMeta(call.name)?.label?.trim() || call.name
}
function toolIcon(call: { name: string }): string {
  return lite.toolMeta(call.name)?.icon?.trim() || '⚙'
}

/** 按节点类型列出要展示的详情分节：用户→正文；模型→思考+正文；工具→工具调用。 */
const sections = computed<LiteDetailSectionName[]>(() => {
  if (!props.node) return []
  if (props.node.kind === 'user') return ['content']
  if (props.node.kind === 'tool') return ['toolCalls']
  return ['thinking', 'content']
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
  const requestedOffset = state.loaded ? state.offset : 0
  sectionLoading.value[requestKey] = true
  try {
    const response = await lite.fetchNodeDetail(nodeId, {
      sections: [section],
      offset: requestedOffset,
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
  <div v-if="props.node" class="lite-drawer-layer">
    <div class="lite-drawer-mask" aria-hidden="true" @click="requestClose" />
    <aside
      ref="dialogRef"
      class="lite-drawer"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lite-detail-title"
      tabindex="-1"
      @keydown="onDialogKeydown"
    >
      <header class="lite-drawer-head">
        <span class="lite-drawer-icon" aria-hidden="true">{{ props.node.icon }}</span>
        <strong id="lite-detail-title">{{ props.node.label }}</strong>
        <span class="lite-drawer-status" :data-status="props.node.status">{{
          runStatusLabel(props.node.status)
        }}</span>
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
                <pre class="lite-pre">{{ sectionText('thinking') }}</pre>
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
                <pre class="lite-pre">{{ sectionText('content') }}</pre>
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
                <article
                  v-for="call in sectionToolCalls()"
                  :key="call.callId"
                  class="lite-tool-call"
                  :class="{ 'is-focused': call.callId === props.focusToolCallId }"
                >
                  <header class="lite-tool-call-head">
                    <span class="lite-tool-call-icon" aria-hidden="true">{{ toolIcon(call) }}</span>
                    <strong>{{ toolLabel(call) }}</strong>
                    <span class="lite-tool-call-status" :data-status="call.status">{{
                      toolStatusLabel(call.status)
                    }}</span>
                  </header>
                  <div class="lite-tool-call-args">
                    <h5>参数</h5>
                    <pre class="lite-pre">{{ call.arguments || '（无参数）' }}</pre>
                  </div>
                  <div class="lite-tool-call-result">
                    <h5>结果</h5>
                    <pre v-if="call.result" class="lite-pre">{{ call.result }}</pre>
                    <p
                      v-else-if="call.status === 'pending' || call.status === 'accepted'"
                      class="lite-drawer-hint is-muted"
                    >
                      等待工具返回…
                    </p>
                    <p v-else class="lite-drawer-hint is-muted">（无结果）</p>
                  </div>
                </article>
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
}
.lite-drawer-status {
  flex: none;
  padding: 0 7px;
  border-radius: 999px;
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
  border-radius: 6px;
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
  scrollbar-width: none;
}
.lite-drawer-body::-webkit-scrollbar {
  display: none;
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
.lite-pre {
  margin: 0;
  padding: 10px 12px;
  background: var(--el-fill-color-lighter);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  font-family: var(--el-font-family-mono);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--el-text-color-primary);
  max-height: 280px;
  overflow: auto;
  scrollbar-width: none;
}
.lite-drawer-error {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--el-color-danger) 10%, transparent);
  color: var(--el-color-danger);
  font-size: 12px;
}
.lite-drawer-hint {
  margin: 0;
  padding: 8px 10px;
  border-radius: 8px;
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
  border-radius: 999px;
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
.lite-tool-call {
  margin-bottom: 10px;
  padding: 10px 12px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  background: var(--el-fill-color-lighter);
}
.lite-tool-call.is-focused {
  outline: 2px solid var(--el-color-primary);
  outline-offset: 1px;
}
.lite-tool-call-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.lite-tool-call-icon {
  font-size: 14px;
  line-height: 1;
}
.lite-tool-call-head strong {
  font-size: 12.5px;
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lite-tool-call-status {
  flex: none;
  font-size: 10.5px;
  color: var(--el-text-color-secondary);
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid var(--el-border-color);
}
.lite-tool-call-status[data-status='accepted'],
.lite-tool-call-status[data-status='pending'] {
  color: var(--el-color-warning);
  border-color: color-mix(in srgb, var(--el-color-warning) 50%, var(--el-border-color));
}
.lite-tool-call-status[data-status='error'],
.lite-tool-call-status[data-status='rejected'] {
  color: var(--el-color-danger);
  border-color: color-mix(in srgb, var(--el-color-danger) 50%, var(--el-border-color));
}
.lite-tool-call-status[data-status='completed'] {
  color: var(--el-color-success);
  border-color: color-mix(in srgb, var(--el-color-success) 50%, var(--el-border-color));
}
.lite-tool-call-args h5,
.lite-tool-call-result h5 {
  margin: 0 0 4px;
  font-size: 11px;
  font-weight: 400;
  color: var(--el-text-color-secondary);
}
.lite-tool-call-args,
.lite-tool-call-result {
  margin-top: 8px;
}
</style>
