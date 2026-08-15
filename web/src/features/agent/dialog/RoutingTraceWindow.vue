<script setup lang="ts">
/**
 * RoutingTraceWindow：会话路由小窗，锚定在 AgentDialog 发送面板右侧。
 * 核心：展示「有哪些会话供大模型选择」+「最终选了哪一个」；
 * 附加：路由 Shadow 的实时 thinking / content 流。
 */
import { computed } from 'vue'
import type { ConversationRouteTrace } from '@/services/agentApi'

const props = defineProps<{
  pos: { left: string; top: string }
  routing: boolean
  trace?: ConversationRouteTrace
  thinking: string
  content: string
}>()

/** 最终选中的会话 id；null=新建对话。 */
const selectedChatId = computed<string | null | undefined>(
  () => props.trace?.response.toolCall.arguments.chatId,
)
const selectedLabel = computed(() => {
  const id = selectedChatId.value
  if (id === null) return '＋新建对话'
  if (id === undefined) return '...'
  const candidate = props.trace?.context.candidates.find((c) => c.chatId === id)
  return candidate?.preview?.trim() || `会话 ${id.slice(0, 8)}`
})
</script>

<template>
  <section
    class="routing-trace-window"
    :style="{ left: pos.left, top: pos.top }"
    role="status"
    aria-live="polite"
  >
    <header class="routing-trace-head">
      <span class="routing-trace-title">AI 会话路由</span>
      <span class="routing-trace-status" :class="{ 'is-routing': routing }">
        {{ routing ? '正在选择会话…' : '已选定目标' }}
      </span>
    </header>

    <div v-if="trace" class="routing-trace-candidates">
      <div class="routing-trace-section-title">可选的会话</div>
      <ul v-if="trace.context.candidates.length" class="routing-trace-list">
        <li
          v-for="candidate in trace.context.candidates"
          :key="candidate.chatId"
          class="routing-trace-item"
          :class="{ 'is-selected': candidate.chatId === selectedChatId }"
        >
          <span class="routing-trace-check" aria-hidden="true">{{
            candidate.chatId === selectedChatId ? '✓' : '·'
          }}</span>
          <span class="routing-trace-item-preview">{{
            candidate.preview?.trim() || '（无历史消息）'
          }}</span>
        </li>
      </ul>
      <div v-else class="routing-trace-empty">（无历史会话候选）</div>
      <div v-if="!routing && selectedChatId !== undefined" class="routing-trace-selection">
        ✓ 大模型选择：{{ selectedLabel }}
      </div>
    </div>

    <div v-if="thinking" class="routing-trace-block">
      <div class="routing-trace-section-title">选择思考</div>
      <p class="routing-trace-text">{{ thinking }}</p>
    </div>

    <div v-if="content" class="routing-trace-block">
      <div class="routing-trace-section-title">正文</div>
      <p class="routing-trace-text">{{ content }}</p>
    </div>

    <div v-if="routing && !thinking && !content" class="routing-trace-idle">
      正在让大模型分析候选会话…
    </div>
  </section>
</template>

<style scoped lang="less">
.routing-trace-window {
  position: fixed;
  z-index: 310;
  width: 280px;
  max-height: 70vh;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--ink) 13%, transparent);
  border-radius: 6px;
  background: var(--panel);
  box-shadow: 0 10px 24px color-mix(in srgb, var(--ink) 20%, transparent);
  color: var(--ink);
  font-size: 11px;
  line-height: 1.5;
}

.routing-trace-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
}
.routing-trace-title {
  font-size: 12px;
  font-weight: 800;
  color: var(--accent-ink);
}
.routing-trace-status {
  font-size: 10px;
  font-weight: 650;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  &.is-routing {
    color: var(--accent-ink);
  }
}

.routing-trace-section-title {
  margin-bottom: 4px;
  font-size: 10px;
  font-weight: 700;
  color: color-mix(in srgb, var(--ink) 48%, transparent);
}

.routing-trace-list {
  display: grid;
  gap: 3px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.routing-trace-item {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 3px 6px;
  border-radius: 4px;
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  &.is-selected {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    color: var(--accent-ink);
    font-weight: 700;
  }
}
.routing-trace-check {
  flex: none;
  font-weight: 800;
}
.routing-trace-item-preview {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.routing-trace-empty {
  color: color-mix(in srgb, var(--ink) 45%, transparent);
}
.routing-trace-selection {
  margin-top: 6px;
  padding: 4px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  color: var(--accent-ink);
  font-weight: 700;
}

.routing-trace-block {
  margin-top: 8px;
}
.routing-trace-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  color: color-mix(in srgb, var(--ink) 82%, transparent);
}

.routing-trace-idle {
  padding: 6px 0;
  color: color-mix(in srgb, var(--ink) 45%, transparent);
}
</style>
