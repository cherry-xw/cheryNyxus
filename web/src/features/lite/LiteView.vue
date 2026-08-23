<script setup lang="ts">
/**
 * LiteView：工作台 lite 极简视图壳（T33 L0 骨架）。
 * 布局契约：docs/web/mcu-lite-workbench-ui.md §2.2——状态条/对话流/交互行(占位)/输入区/底栏(占位)。
 * L0 仅骨架+状态条；对话流渲染 L1、交互 L2、详情抽屉 L3。
 */
import { computed } from 'vue'
import { useLiteStore } from './liteStore'

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
      return '加载失败'
    default:
      return ''
  }
})

const runningLabel = computed(() =>
  lite.runningState ? '运行中…' : '',
)

const nodeCountLabel = computed(() => `${lite.leanTimeline.length} 节点`)
</script>

<template>
  <div class="lite-view" :data-window="props.windowId">
    <!-- 状态条（§2.2） -->
    <div class="lite-statusbar">
      <span class="lite-conn" :data-phase="lite.connection.phase">{{ connectionLabel }}</span>
      <span v-if="hydrationLabel" class="lite-hydration">{{ hydrationLabel }}</span>
      <span v-if="runningLabel" class="lite-running">⟳ {{ runningLabel }}</span>
      <span class="lite-session">{{ props.presetName || '会话' }}{{ lite.rootChatId ? ' · ' + lite.rootChatId.slice(0, 8) : '' }}</span>
      <span class="lite-traffic">≈ {{ trafficLabel }}</span>
    </div>

    <!-- 对话流（L1 实装渲染；L0 占位） -->
    <div class="lite-stream" aria-label="对话流">
      <p class="lite-placeholder">lite 极简视图（L0 骨架）——对话流渲染于 L1 上线</p>
    </div>

    <!-- 审批/提问行（L2 占位） -->
    <div class="lite-interaction-slot" aria-hidden="true" />

    <!-- 输入区（L2 实装 chat.input.submit；L0 占位） -->
    <div class="lite-input">
      <input
        type="text"
        class="lite-input-box"
        placeholder="发送消息（L2 上线）"
        disabled
      >
    </div>

    <!-- 底栏（分页/详情入口，L3 占位） -->
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

.lite-conn[data-phase='connected'] {
  color: var(--el-color-success);
}
.lite-conn[data-phase='reconnecting'],
.lite-conn[data-phase='connecting'] {
  color: var(--el-color-warning);
}
.lite-conn[data-phase='unsupported'] {
  color: var(--el-color-danger);
}

.lite-traffic {
  margin-left: auto;
}

.lite-stream {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
}

.lite-placeholder {
  color: var(--el-text-color-placeholder);
  text-align: center;
  margin-top: 32px;
}

.lite-interaction-slot {
  flex: none;
}

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
