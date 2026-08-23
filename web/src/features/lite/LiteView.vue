<script setup lang="ts">
/**
 * LiteView：工作台 lite 极简视图（T33 L0 壳 + T34 L1 对话流）。
 * 布局契约：docs/web/mcu-lite-workbench-ui.md §2.2；渲染规则 §4.1；分页 §4.7。
 * L2：发送/审批/停止；L3：详情抽屉（node.get）。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useLiteStore, type LeanTimelineNode } from './liteStore'

const props = defineProps<{ windowId: string; presetName?: string }>()

const lite = useLiteStore()

const connectionLabel = computed(() => {
  switch (lite.connection.phase) {
    case 'idle':
      return '未连接'
    case 'connecting':
      return '连接中…'
    case 'connected':
      return '已连接'
    case 'reconnecting':
      return `重连中…（第 ${lite.connection.reconnectAttempts} 次退避）`
    case 'unsupported':
      return '版本不兼容（服务端 lite profile 版本过新，请升级）'
    default:
      return '—'
  }
})

const trafficLabel = computed(() => {
  const kb = lite.connection.receivedBytes / 1024
  return kb >= 1 ? `${kb.toFixed(1)} KB` : `${lite.connection.receivedBytes} B`
})

const hydrationLabel = computed(() => {
  switch (lite.hydration) {
    case 'idle':
      return ''
    case 'chat-list':
      return '加载会话…'
    case 'chat-open':
      return '加载时间线…'
    case 'interaction-list':
      return '加载待办…'
    case 'ready':
      return ''
    case 'failed':
      return `加载失败：${lite.hydrationError ?? '未知错误'}`
    default:
      return ''
  }
})

/** 主对话流（§4.1）：用户消息 + 最终回复；中间节点状态行穿插（按 orderKey 归并）。 */
interface StreamRow {
  key: string
  kind: 'user' | 'agent-reply' | 'process'
  node?: LeanTimelineNode
}

const streamRows = computed<StreamRow[]>(() => {
  const rows: StreamRow[] = []
  const merged = [...lite.mainStreamNodes, ...lite.processNodes].sort((a, b) => a.orderKey - b.orderKey)
  for (const node of merged) {
    if (node.actorKind === 'user') {
      rows.push({ key: node.id, kind: 'user', node })
    } else if (node.direction === 'agent-to-user') {
      rows.push({ key: node.id, kind: 'agent-reply', node })
    } else {
      rows.push({ key: node.id, kind: 'process', node })
    }
  }
  return rows
})

/** done.finalMessage 即时终态（§4.1 T31 W2 修正）：patch 权威节点未到时先行显示。 */
const liveFinalMessage = computed(() => {
  if (!lite.finalMessage) return null
  const exists = lite.leanTimeline.some(
    (n) => n.id === lite.finalMessage?.msgId && n.direction === 'agent-to-user',
  )
  return exists ? null : lite.finalMessage
})

const showRunningRow = computed(() => !!lite.runningState && !liveFinalMessage.value)

/** 状态行图标：termination code 判定（§4.1）。 */
function processIcon(node: LeanTimelineNode): string {
  const code = node.termination?.code
  if (node.status === 'revoked') return '✗'
  if (typeof code === 'string') return code === 'user_abort' || code === 'error' ? '✗' : '✓'
  return '⟳'
}

function processLabel(node: LeanTimelineNode): string {
  if (node.toolNames?.length) return node.toolNames.join(', ')
  return node.summary?.slice(0, 40) || node.kind
}

// ---- 分页（§4.7）----
const loadingOlder = ref(false)
async function loadOlder() {
  if (loadingOlder.value) return
  loadingOlder.value = true
  try {
    await lite.loadOlder()
  } finally {
    loadingOlder.value = false
  }
}

// ---- 子任务展开（§4.1 v0.2）----
const subTaskExpanded = ref(false)
const subTaskNodes = computed(() => lite.subTaskNodes)

// ---- 自动滚动（新消息到底，除非用户上滚；加载更早保持视口）----
const streamEl = ref<HTMLElement | null>(null)
const autoScroll = ref(true)
function onStreamScroll() {
  const el = streamEl.value
  if (!el) return
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight < 40
}
async function scrollToBottom() {
  if (!autoScroll.value) return
  await nextTick()
  const el = streamEl.value
  if (el) el.scrollTop = el.scrollHeight
}
onMounted(scrollToBottom)
watch(
  () => [streamRows.value.length, lite.finalMessage?.receivedAt, lite.runningState !== null],
  scrollToBottom,
)
async function loadOlderPreserve() {
  const el = streamEl.value
  const prevHeight = el?.scrollHeight ?? 0
  await loadOlder()
  await nextTick()
  if (el) el.scrollTop = el.scrollHeight - prevHeight
}

const nodeCountLabel = computed(() =>
  lite.nodeCount !== null ? `${lite.nodeCount} 节点` : `${lite.leanTimeline.length} 节点`,
)
</script>

<template>
  <div class="lite-view" :data-window="props.windowId">
    <div class="lite-statusbar">
      <span class="lite-conn" :data-phase="lite.connection.phase">{{ connectionLabel }}</span>
      <span v-if="hydrationLabel" class="lite-hydration">{{ hydrationLabel }}</span>
      <span v-if="lite.runningState" class="lite-running">⟳ 运行中…</span>
      <span class="lite-session">{{ props.presetName || '会话' }}{{ lite.rootChatId ? ' · ' + lite.rootChatId.slice(0, 8) : '' }}</span>
      <span class="lite-traffic">≈ {{ trafficLabel }}</span>
    </div>

    <div ref="streamEl" class="lite-stream" aria-label="对话流" @scroll="onStreamScroll">
      <button
        v-if="lite.hasMoreOlder"
        type="button"
        class="lite-load-older"
        :disabled="loadingOlder"
        @click="loadOlderPreserve"
      >
        {{ loadingOlder ? '加载中…' : '加载更早' }}
      </button>

      <template v-for="row in streamRows" :key="row.key">
        <div v-if="row.kind === 'user'" class="lite-row lite-user">
          <span class="lite-role">[用户]</span>
          <span class="lite-text">{{ row.node?.summary }}</span>
        </div>

        <div v-else-if="row.kind === 'agent-reply'" class="lite-row lite-reply">
          <span class="lite-role">[agent]</span>
          <span class="lite-text">{{ row.node?.summary }}</span>
          <button type="button" class="lite-detail-btn" title="详情（L3 上线）" disabled>详情 &gt;</button>
        </div>

        <div v-else class="lite-row lite-process" role="button" tabindex="0">
          <span class="lite-icon">{{ processIcon(row.node!) }}</span>
          <span class="lite-text">{{ processLabel(row.node!) }}</span>
        </div>
      </template>

      <div v-if="liveFinalMessage" class="lite-row lite-reply">
        <span class="lite-role">[agent]</span>
        <span class="lite-text">{{ liveFinalMessage.content }}</span>
        <button type="button" class="lite-detail-btn" title="详情（L3 上线）" disabled>详情 &gt;</button>
      </div>

      <div v-if="showRunningRow" class="lite-row lite-process">
        <span class="lite-icon">⟳</span>
        <span class="lite-text">运行中…</span>
        <button type="button" class="lite-stop-btn" title="停止（L2 上线）" disabled>停止</button>
      </div>

      <div v-if="subTaskNodes.length > 0" class="lite-subtask">
        <button type="button" class="lite-subtask-toggle" @click="subTaskExpanded = !subTaskExpanded">
          {{ subTaskExpanded ? '▾' : '▸' }} 子任务（{{ subTaskNodes.length }}）
        </button>
        <div v-if="subTaskExpanded" class="lite-subtask-list">
          <div
            v-for="n in subTaskNodes"
            :key="n.id"
            class="lite-row lite-subtask-row"
            :data-direction="n.direction"
          >
            <span class="lite-icon">{{ n.direction === 'child-to-parent' ? '✓' : '⟳' }}</span>
            <span class="lite-text">{{ n.summary?.slice(0, 50) }}</span>
          </div>
        </div>
      </div>
    </div>

    <div class="lite-interaction-slot" aria-hidden="true" />

    <div class="lite-input">
      <input
        type="text"
        class="lite-input-box"
        placeholder="发送消息（L2 上线）"
        disabled
      >
    </div>

    <div class="lite-footer">
      <span class="lite-nodecount">{{ nodeCountLabel }}</span>
      <span class="lite-actions">…</span>
    </div>
  </div>
</template>

<style scoped>
.lite-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  font-size: 13px;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color);
}

.lite-statusbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
  font-size: 12px;
  color: var(--el-text-color-secondary);
  flex: none;
}

.lite-conn[data-phase='connected'] { color: var(--el-color-success); }
.lite-conn[data-phase='reconnecting'],
.lite-conn[data-phase='connecting'] { color: var(--el-color-warning); }
.lite-conn[data-phase='unsupported'] { color: var(--el-color-danger); }

.lite-traffic { margin-left: auto; }

.lite-stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}

.lite-load-older {
  display: block;
  margin: 0 auto 10px;
  padding: 2px 12px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: transparent;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
  cursor: pointer;
}
.lite-load-older:hover:not(:disabled) { color: var(--el-color-primary); border-color: var(--el-color-primary); }
.lite-load-older:disabled { opacity: 0.6; cursor: default; }

.lite-row {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 4px 0;
  line-height: 1.5;
  word-break: break-all;
}

.lite-role { flex: none; color: var(--el-text-color-secondary); font-size: 12px; }
.lite-user .lite-text { white-space: pre-wrap; }
.lite-reply .lite-text { color: var(--el-text-color-primary); }
.lite-reply .lite-role { color: var(--el-color-primary); }

.lite-process { color: var(--el-text-color-secondary); font-size: 12px; cursor: pointer; }
.lite-process:hover { color: var(--el-text-color-primary); }

.lite-icon { flex: none; width: 14px; text-align: center; }

.lite-detail-btn,
.lite-stop-btn {
  flex: none;
  padding: 0 6px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
}
.lite-detail-btn:enabled:hover,
.lite-stop-btn:enabled:hover { color: var(--el-color-primary); }
.lite-stop-btn:disabled { opacity: 0.5; cursor: default; }

.lite-subtask { margin-top: 8px; border-top: 1px dashed var(--el-border-color-lighter); padding-top: 6px; }
.lite-subtask-toggle {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  background: transparent;
  border: none;
  cursor: pointer;
}
.lite-subtask-row { font-size: 12px; color: var(--el-text-color-secondary); }

.lite-interaction-slot { flex: none; }

.lite-input {
  flex: none;
  padding: 8px 12px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.lite-input-box {
  width: 100%;
  box-sizing: border-box;
  padding: 6px 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  background: var(--el-fill-color-blank);
  color: inherit;
}

.lite-footer {
  flex: none;
  display: flex;
  justify-content: space-between;
  padding: 4px 12px;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
  border-top: 1px solid var(--el-border-color-lighter);
}
</style>
