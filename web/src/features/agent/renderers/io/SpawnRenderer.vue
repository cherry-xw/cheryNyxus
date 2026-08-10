<script setup lang="ts">
/**
 * SpawnRenderer：spawn_role 专用渲染器。
 *
 * UI 设计：
 * - 头部：🤖 图标 + "派遣角色" + 角色类型
 * - 角色信息：type + prompt（截断到 100 字符）
 * - 状态：wake 策略（immediate/deferred/barrier）映射显示文案
 * - chatId：显示子 chat ID（可点击跳转）
 */
import { computed } from 'vue'
import type { RendererProps, SpawnRoleArgs } from '../types'
import { useHistoryDrawerManager } from '../../drawer/useHistoryDrawerManager'

const props = defineProps<RendererProps>()
const manager = useHistoryDrawerManager()

// 解析参数
const parsedArgs = computed<SpawnRoleArgs | null>(() => {
  try {
    const raw =
      typeof props.call.args === 'string' ? props.call.args : JSON.stringify(props.call.args ?? {})
    const obj = JSON.parse(raw) as SpawnRoleArgs
    if (obj.type && obj.prompt) return obj
    return null
  } catch (e) {
    console.warn('[SpawnRenderer] args 解析失败', e)
    return null
  }
})

// prompt 截断（100 字符）
const promptPreview = computed(() => {
  const prompt = parsedArgs.value?.prompt ?? ''
  if (prompt.length <= 100) return prompt
  return prompt.slice(0, 100) + '...'
})

// 从结果提取 chatId
const chatId = computed<string | null>(() => {
  if (!props.call.result || typeof props.call.result !== 'string') return null
  const text = props.call.result as string

  // 匹配 chatId=xxx 格式
  const match = text.match(/chatId=([a-f0-9-]+)/)
  return match?.[1] ?? null
})

// wake 策略中文映射（status: running/done 各态）
const WAKE_LABEL_RUNNING: Record<NonNullable<SpawnRoleArgs['wake']>, string> = {
  immediate: '等待结果',
  deferred: '后台派发',
  barrier: '栅栏等待',
}
const WAKE_LABEL_DONE: Record<NonNullable<SpawnRoleArgs['wake']>, string> = {
  immediate: '已完成',
  deferred: '已暂存',
  barrier: '栅栏完成',
}

// 状态标签
const statusLabel = computed(() => {
  const wake = parsedArgs.value?.wake ?? 'immediate'
  if (props.call.status === 'running') {
    return WAKE_LABEL_RUNNING[wake] ?? '派发中'
  }
  if (props.call.status === 'done') {
    return WAKE_LABEL_DONE[wake] ?? '已派发'
  }
  if (props.call.status === 'error') {
    return '错误'
  }
  return ''
})

// 状态字形和样式
const statusGlyph = computed(() => {
  switch (props.call.status) {
    case 'running':
      return '⋯'
    case 'done':
      return '✓'
    case 'error':
      return '✗'
    default:
      return '?'
  }
})

const statusClass = computed(() => `status-${props.call.status}`)

// 降级显示
const fallback = computed(() => {
  if (!parsedArgs.value) {
    return JSON.stringify(props.call.args ?? {}, null, 2)
  }
  return ''
})

// 点击「详情」→ 下钻子 chat 抽屉（manager 跨层下发，盖在当前抽屉之上）
function onDrillDetail(): void {
  if (chatId.value) manager.drillChild(chatId.value)
}
</script>

<template>
  <div class="spawn-box" :class="statusClass">
    <div class="spawn-head">
      <span class="spawn-icon" aria-hidden="true">🤖</span>
      <span class="spawn-name">派遣角色</span>
      <span class="spawn-type">{{ parsedArgs?.type ?? 'unknown' }}</span>
      <span class="spawn-status" aria-hidden="true">{{ statusGlyph }}</span>
    </div>

    <!-- 角色信息 -->
    <div v-if="parsedArgs" class="spawn-section">
      <div class="spawn-row">
        <span class="spawn-label">角色:</span>
        <code class="spawn-value">{{ parsedArgs.type }}</code>
      </div>
      <div class="spawn-row">
        <span class="spawn-label">任务:</span>
        <span class="spawn-prompt">{{ promptPreview }}</span>
      </div>
      <div v-if="parsedArgs.wake !== undefined" class="spawn-row">
        <span class="spawn-label">唤醒:</span>
        <span class="spawn-badge">{{ parsedArgs.wake }}</span>
      </div>
    </div>

    <!-- 参数解析失败降级 -->
    <pre v-else-if="fallback" class="spawn-fallback">{{ fallback }}</pre>

    <!-- 会话详情（点击下钻子 chat 抽屉） -->
    <div v-if="chatId" class="spawn-section">
      <div class="spawn-row">
        <span class="spawn-label">会话:</span>
        <button type="button" class="spawn-detail-link" @click="onDrillDetail">详情</button>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);

.spawn-box {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  font-size: 11px;
  color: color-mix(in srgb, var(--ink) 80%, transparent);
}

.spawn-head {
  display: flex;
  align-items: center;
  gap: 6px;

  .spawn-icon {
    font-size: 12px;
  }

  .spawn-name {
    font-weight: 700;
    color: color-mix(in srgb, var(--ink) 86%, transparent);
  }

  .spawn-type {
    flex: 1;
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 3px;
    background: rgba(168, 85, 247, 0.12);
    color: #2563eb;
    font-weight: 700;
    text-align: right;
  }

  .spawn-status {
    font-weight: 800;
    font-size: 12px;

    &.status-done {
      color: #16a34a;
    }
    &.status-running {
      color: #eab308;
      animation: spawn-pulse 1.1s ease-in-out infinite;
    }
    &.status-error {
      color: #dc2626;
    }
  }
}

.spawn-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.spawn-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
}

.spawn-label {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  color: color-mix(in srgb, var(--ink) 56%, transparent);
}

.spawn-value {
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
}

.spawn-prompt {
  flex: 1;
  min-width: 0;
  font-size: 10.5px;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  white-space: pre-wrap;
  word-break: break-word;
}

.spawn-badge {
  display: inline-block;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  background: rgba(59, 130, 246, 0.12);
  color: #2563eb;
}

.spawn-fallback {
  margin: 0;
  padding: 6px 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 6%, transparent);
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 200px;
  overflow: auto;
}

.spawn-detail-link {
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 10.5px;
  color: var(--ink);
  color: #2563eb;

  &:hover {
    text-decoration: underline;
  }
}

@keyframes spawn-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}
</style>
