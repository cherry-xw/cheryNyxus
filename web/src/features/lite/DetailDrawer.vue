<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useLiteStore } from './liteStore'
import { useLiteCanonicalView, type LeanTimelineNode } from './useLiteCanonicalView'
import {
  formatDetailValue,
  mergeDetailSectionPage,
  type LiteDetailSectionName,
  type LiteDetailSectionState,
} from './detailSections'

const props = defineProps<{
  windowId: string
  rootChatId: string
  nodeId: string | null | undefined
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
const closeButtonRef = ref<HTMLButtonElement | null>(null)
const expandedSections = ref<LiteDetailSectionName[]>([])
const loadingRequests = reactive<Record<string, boolean>>({})
const DETAIL_PAGE_LIMIT = 8000

const leanNode = computed<LeanTimelineNode | undefined>(() =>
  props.nodeId ? lite.leanTimeline.find((node) => node.id === props.nodeId) : undefined,
)
const detail = computed(() => {
  if (!props.nodeId) return undefined
  return liteUi.rootUi(props.windowId, props.rootChatId)?.detailCache[props.nodeId]
})

function sectionState(section: LiteDetailSectionName): LiteDetailSectionState | undefined {
  return detail.value?.[section]
}

function isExpanded(section: LiteDetailSectionName): boolean {
  return expandedSections.value.includes(section)
}

function detailRequestKey(
  section: LiteDetailSectionName,
  windowId = props.windowId,
  rootChatId = props.rootChatId,
  nodeId = props.nodeId,
): string {
  return `${windowId}:${rootChatId}:${nodeId ?? ''}:${section}`
}

function isLoading(section: LiteDetailSectionName): boolean {
  return loadingRequests[detailRequestKey(section)] === true
}

async function loadSection(section: LiteDetailSectionName): Promise<void> {
  const windowId = props.windowId
  const rootChatId = props.rootChatId
  const nodeId = props.nodeId
  if (!nodeId) return
  const requestKey = detailRequestKey(section, windowId, rootChatId, nodeId)
  if (loadingRequests[requestKey]) return
  const current = liteUi.ensureNodeDetail(windowId, rootChatId, nodeId)[section]
  if (current.loaded && !current.hasMore) return
  const requestedOffset = current.loaded ? current.offset : 0
  loadingRequests[requestKey] = true
  try {
    const response = await lite.fetchNodeDetail(nodeId, {
      sections: [section],
      offset: requestedOffset,
      limit: DETAIL_PAGE_LIMIT,
    })
    if (!response.success) {
      liteUi.patchDetailSection(windowId, rootChatId, nodeId, section, {
        ...current,
        error: response.error.message,
      })
      return
    }
    liteUi.patchDetailSection(
      windowId,
      rootChatId,
      nodeId,
      section,
      mergeDetailSectionPage(current, section, response.data, requestedOffset, DETAIL_PAGE_LIMIT),
    )
  } finally {
    delete loadingRequests[requestKey]
  }
}

async function toggleSection(section: LiteDetailSectionName): Promise<void> {
  if (isExpanded(section)) {
    expandedSections.value = expandedSections.value.filter((item) => item !== section)
    return
  }
  expandedSections.value = [...expandedSections.value, section]
  const state = sectionState(section)
  if (!state?.loaded) await loadSection(section)
}

const visibleToolCalls = computed(() => {
  const calls = detail.value?.toolCalls.toolCalls ?? []
  if (!props.focusToolCallId) return calls
  const focused = calls.find((call) => call.callId === props.focusToolCallId)
  return focused ? [focused] : []
})

function requestClose(): void {
  emit('close')
}

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
  () => [props.windowId, props.rootChatId, props.nodeId, props.initialSection] as const,
  async ([, , nodeId, initialSection], previous) => {
    if (!nodeId) return
    if (
      nodeId !== previous?.[2] ||
      props.windowId !== previous?.[0] ||
      props.rootChatId !== previous?.[1]
    ) {
      expandedSections.value = []
    }
    await nextTick()
    closeButtonRef.value?.focus()
    if (initialSection && !isExpanded(initialSection)) {
      expandedSections.value = [...expandedSections.value, initialSection]
      if (!sectionState(initialSection)?.loaded) await loadSection(initialSection)
    }
  },
  { immediate: true },
)
</script>

<template>
  <Teleport to="body">
    <div v-if="nodeId" class="lite-drawer-mask" @click.self="requestClose">
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
          <strong id="lite-detail-title">{{ leanNode?.kind ?? '节点' }}详情</strong>
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

        <div class="lite-drawer-body">
          <p class="lite-drawer-hint">详情仅在展开对应栏目时加载。</p>

          <section class="lite-drawer-section">
            <button
              type="button"
              class="lite-section-toggle"
              :aria-expanded="isExpanded('content')"
              @click="toggleSection('content')"
            >
              <span>{{ isExpanded('content') ? '▾' : '▸' }} 正文</span>
              <span v-if="isLoading('content')">加载中…</span>
            </button>
            <div v-if="isExpanded('content')" class="lite-section-content">
              <p v-if="sectionState('content')?.error" class="lite-drawer-error" role="alert">
                {{ sectionState('content')?.error }}
              </p>
              <pre v-else-if="sectionState('content')?.loaded" class="lite-pre">{{
                sectionState('content')?.text || '无正文'
              }}</pre>
              <button
                v-if="sectionState('content')?.hasMore"
                type="button"
                class="lite-drawer-more"
                :disabled="isLoading('content')"
                @click="loadSection('content')"
              >
                加载更多正文
              </button>
            </div>
          </section>

          <section class="lite-drawer-section">
            <button
              type="button"
              class="lite-section-toggle"
              :aria-expanded="isExpanded('thinking')"
              @click="toggleSection('thinking')"
            >
              <span>{{ isExpanded('thinking') ? '▾' : '▸' }} 思考</span>
              <span v-if="isLoading('thinking')">加载中…</span>
            </button>
            <div v-if="isExpanded('thinking')" class="lite-section-content">
              <p v-if="sectionState('thinking')?.error" class="lite-drawer-error" role="alert">
                {{ sectionState('thinking')?.error }}
              </p>
              <pre v-else-if="sectionState('thinking')?.loaded" class="lite-pre">{{
                sectionState('thinking')?.text || '无思考内容'
              }}</pre>
              <button
                v-if="sectionState('thinking')?.hasMore"
                type="button"
                class="lite-drawer-more"
                :disabled="isLoading('thinking')"
                @click="loadSection('thinking')"
              >
                加载更多思考
              </button>
            </div>
          </section>

          <section class="lite-drawer-section">
            <button
              type="button"
              class="lite-section-toggle"
              :aria-expanded="isExpanded('toolCalls')"
              @click="toggleSection('toolCalls')"
            >
              <span>{{ isExpanded('toolCalls') ? '▾' : '▸' }} 工具详情</span>
              <span v-if="isLoading('toolCalls')">加载中…</span>
            </button>
            <div v-if="isExpanded('toolCalls')" class="lite-section-content">
              <p v-if="sectionState('toolCalls')?.error" class="lite-drawer-error" role="alert">
                {{ sectionState('toolCalls')?.error }}
              </p>
              <p
                v-else-if="sectionState('toolCalls')?.loaded && visibleToolCalls.length === 0"
                class="lite-drawer-hint"
              >
                未找到对应工具调用。
              </p>
              <article
                v-for="call in visibleToolCalls"
                :key="call.callId"
                class="lite-toolcall"
                :data-tool-call-id="call.callId"
              >
                <h4>{{ call.name || '工具调用' }}</h4>
                <h5>参数</h5>
                <pre class="lite-pre">{{ formatDetailValue(call.arguments) }}</pre>
                <h5 v-if="call.result !== undefined">结果</h5>
                <pre v-if="call.result !== undefined" class="lite-pre">{{
                  formatDetailValue(call.result)
                }}</pre>
              </article>
              <button
                v-if="sectionState('toolCalls')?.hasMore"
                type="button"
                class="lite-drawer-more"
                :disabled="isLoading('toolCalls')"
                @click="loadSection('toolCalls')"
              >
                加载更多工具详情
              </button>
            </div>
          </section>
        </div>
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
.lite-drawer-mask {
  position: fixed;
  inset: 0;
  z-index: 2100;
  display: flex;
  justify-content: flex-end;
  background: rgb(0 0 0 / 35%);
}

.lite-drawer {
  width: min(520px, 92vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
  border-left: 1px solid var(--el-border-color-lighter);
  box-shadow: -4px 0 16px rgb(0 0 0 / 12%);
  outline: none;
}

.lite-drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.lite-drawer-close {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  font-size: 14px;
}

.lite-drawer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  font-size: 13px;
}

.lite-drawer-section {
  margin-top: 8px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
  overflow: hidden;
}

.lite-section-toggle {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 10px;
  border: 0;
  background: var(--el-fill-color-light);
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.lite-section-content {
  padding: 10px;
}
.lite-drawer-error {
  color: var(--el-color-danger);
}
.lite-drawer-hint {
  color: var(--el-text-color-placeholder);
}
.lite-toolcall + .lite-toolcall {
  margin-top: 14px;
}
.lite-toolcall h4 {
  margin: 0 0 6px;
}
.lite-toolcall h5 {
  margin: 8px 0 3px;
  color: var(--el-text-color-secondary);
}

.lite-pre {
  margin: 0;
  padding: 8px;
  max-height: 320px;
  overflow: auto;
  border-radius: 6px;
  background: var(--el-fill-color-light);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 12px;
}

.lite-drawer-more {
  display: block;
  margin: 10px auto 0;
  padding: 4px 16px;
  border: 1px solid var(--el-color-primary);
  border-radius: 10px;
  background: transparent;
  color: var(--el-color-primary);
  cursor: pointer;
}

.lite-drawer-more:disabled {
  cursor: default;
  opacity: 0.5;
}
</style>
