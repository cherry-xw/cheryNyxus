<script setup lang="ts">
/**
 * DetailDrawer：lite 视图按需详情抽屉（T36 L3）。
 * 契约：docs/web/mcu-lite-workbench-ui.md §4.4 + T31 D 定案——node.get 分段全文、
 * refs(contentHash) 引用、hasMore 续拉；审批「查看全文」走 toolCalls sections（id 映射）。
 */
import { computed, ref, watch } from 'vue'
import { useLiteStore, type LeanTimelineNode } from './liteStore'

const props = defineProps<{
  nodeId: string | null | undefined
  /** 审批查看全文模式：定位 toolCall 用（interactionId = sense call id，D 定案）。 */
  focusToolCallId?: string | null
}>()
const emit = defineEmits<{ close: [] }>()

const lite = useLiteStore()

interface NodeDetail {
  id: string
  kind?: string
  content?: string
  thinking?: string
  toolCalls?: Array<Record<string, unknown>>
  refs: Array<{ field: string; contentLength: number; contentHash: string }>
  hasMore: boolean
  /** 本段 offset（字符语义，续拉起点）。 */
  offset: number
}

const detail = ref<NodeDetail | null>(null)
const loading = ref(false)
const showThinking = ref(false)
const errorText = ref<string | null>(null)

const leanNode = computed<LeanTimelineNode | undefined>(() =>
  props.nodeId ? lite.leanTimeline.find((n) => n.id === props.nodeId) : undefined,
)

async function load(offset = 0, append = false) {
  if (!props.nodeId || !lite.rootChatId || loading.value) return
  loading.value = true
  errorText.value = null
  try {
    const sections: Array<'content' | 'thinking' | 'toolCalls'> = ['content', 'toolCalls']
    if (showThinking.value) sections.unshift('thinking')
    const res = await lite.fetchNodeDetail(props.nodeId, {
      sections,
      offset,
      limit: 8000,
    })
    if (!res.success) {
      errorText.value = res.error?.message ?? '加载失败'
      return
    }
    const data = res.data as {
      node: { content?: string; thinking?: string; toolCalls?: Array<Record<string, unknown>> }
      refs?: NodeDetail['refs']
      hasMore?: boolean
    }
    const node = data.node
    if (append && detail.value) {
      // 续拉：文本字段拼接（offset 语义）
      detail.value = {
        ...detail.value,
        content: (detail.value.content ?? '') + (node.content ?? ''),
        thinking: (detail.value.thinking ?? '') + (node.thinking ?? ''),
        toolCalls: node.toolCalls ?? detail.value.toolCalls,
        refs: data.refs ?? [],
        hasMore: data.hasMore === true,
        offset: offset + (node.content?.length ?? node.thinking?.length ?? 0),
      }
    } else {
      detail.value = {
        id: props.nodeId,
        content: node.content,
        thinking: node.thinking,
        toolCalls: node.toolCalls,
        refs: data.refs ?? [],
        hasMore: data.hasMore === true,
        offset: (node.content ?? node.thinking ?? '').length,
      }
    }
  } finally {
    loading.value = false
  }
}

watch(
  () => props.nodeId,
  (id) => {
    detail.value = null
    if (id) void load(0, false)
  },
  { immediate: true },
)
watch(showThinking, () => {
  if (props.nodeId) void load(0, false)
})

/** 审批查看全文：定位 focusToolCallId（D 定案 id 映射）。 */
const focusedToolCall = computed(() => {
  if (!props.focusToolCallId || !detail.value?.toolCalls) return null
  return detail.value.toolCalls.find((c) => c.id === props.focusToolCallId) ?? null
})

function toolName(call: Record<string, unknown>): string {
  return typeof call.name === 'string' ? call.name : '?'
}
function toolField(call: Record<string, unknown>, key: string): string {
  const v = call[key]
  if (typeof v === 'string') return v.length > 400 ? v.slice(0, 400) + '…' : v
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="nodeId" class="lite-drawer-mask" @click.self="emit('close')">
      <aside class="lite-drawer" role="dialog" aria-label="节点详情">
        <header class="lite-drawer-head">
          <strong>{{ leanNode?.kind ?? '节点' }} 详情</strong>
          <label class="lite-drawer-toggle">
            <input type="checkbox" v-model="showThinking">思考
          </label>
          <button type="button" class="lite-drawer-close" aria-label="关闭" @click="emit('close')">✕</button>
        </header>

        <div class="lite-drawer-body">
          <p v-if="errorText" class="lite-drawer-error">{{ errorText }}</p>
          <p v-else-if="loading && !detail" class="lite-drawer-hint">加载中…</p>

          <template v-if="detail">
            <!-- 审批查看全文：定位 toolCall（D 定案） -->
            <section v-if="focusedToolCall" class="lite-drawer-section">
              <h4>{{ toolName(focusedToolCall) }}</h4>
              <template v-if="typeof focusedToolCall.arguments === 'string'">
                <h5>参数</h5>
                <pre class="lite-pre">{{ focusedToolCall.arguments }}</pre>
              </template>
              <template v-if="typeof focusedToolCall.result === 'string'">
                <h5>结果</h5>
                <pre class="lite-pre">{{ focusedToolCall.result }}</pre>
              </template>
            </section>

            <!-- toolCalls 全量（非聚焦模式） -->
            <section v-else-if="detail.toolCalls?.length" class="lite-drawer-section">
              <h4>工具调用（{{ detail.toolCalls.length }}）</h4>
              <details v-for="(call, i) in detail.toolCalls" :key="i" class="lite-toolcall">
                <summary>{{ toolName(call) }}</summary>
                <h5>参数</h5>
                <pre class="lite-pre">{{ toolField(call, 'arguments') }}</pre>
                <h5>结果</h5>
                <pre class="lite-pre">{{ toolField(call, 'result') }}</pre>
              </details>
            </section>

            <section v-if="detail.content" class="lite-drawer-section">
              <h4>正文</h4>
              <pre class="lite-pre">{{ detail.content }}</pre>
            </section>

            <section v-if="showThinking && detail.thinking" class="lite-drawer-section">
              <h4>思考</h4>
              <pre class="lite-pre">{{ detail.thinking }}</pre>
            </section>

            <!-- 截断引用（对账信息） -->
            <p v-if="detail.refs.length" class="lite-drawer-refs">
              截断 {{ detail.refs.length }} 个超长字段（contentHash 校验可用）
            </p>

            <button
              v-if="detail.hasMore"
              type="button"
              class="lite-drawer-more"
              :disabled="loading"
              @click="load(detail.offset, true)"
            >{{ loading ? '加载中…' : '加载更多' }}</button>
          </template>
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
  background: rgb(0 0 0 / 35%);
  display: flex;
  justify-content: flex-end;
}
.lite-drawer {
  width: min(480px, 90vw);
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--el-bg-color);
  border-left: 1px solid var(--el-border-color-lighter);
  box-shadow: -4px 0 16px rgb(0 0 0 / 12%);
}
.lite-drawer-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  flex: none;
}
.lite-drawer-toggle {
  margin-left: auto;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.lite-drawer-close {
  border: none;
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
.lite-drawer-error { color: var(--el-color-danger); }
.lite-drawer-hint { color: var(--el-text-color-placeholder); }
.lite-drawer-section { margin-bottom: 14px; }
.lite-drawer-section h4 { margin: 8px 0 4px; font-size: 13px; }
.lite-drawer-section h5 { margin: 6px 0 2px; font-size: 12px; color: var(--el-text-color-secondary); }
.lite-pre {
  margin: 0;
  padding: 8px;
  background: var(--el-fill-color-light);
  border-radius: 6px;
  white-space: pre-wrap;
  word-break: break-all;
  font-size: 12px;
  max-height: 280px;
  overflow-y: auto;
}
.lite-toolcall summary {
  cursor: pointer;
  font-size: 12px;
  color: var(--el-color-primary);
  padding: 2px 0;
}
.lite-drawer-refs {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}
.lite-drawer-more {
  display: block;
  margin: 8px auto;
  padding: 4px 16px;
  font-size: 12px;
  color: var(--el-color-primary);
  background: transparent;
  border: 1px solid var(--el-color-primary);
  border-radius: 10px;
  cursor: pointer;
}
.lite-drawer-more:disabled { opacity: 0.5; cursor: default; }
</style>
