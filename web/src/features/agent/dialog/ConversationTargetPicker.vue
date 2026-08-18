<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch, type ComponentPublicInstance, type Ref } from 'vue'
import { agentApi, type ChatSummary, type ConversationRouteTrace } from '@/services/agentApi'
import { formatTime } from '@/utils/formatTime'
import {
  conversationTargetVisualState,
  nextTargetCycleState,
  visibleConversationTargetSessions,
  type ConversationTargetVisualState,
  type RouteStatus,
  type TargetCycleState,
} from './conversationTargetRouting'
import { splitCommandPrompt, type CommandPromptSegment } from '../composables/commands'

const props = defineProps<{
  presetId: string
  sessions: ChatSummary[]
  selected: string | 'new' | undefined
  selectedSource?: 'ai' | 'user'
  routingEnabled: boolean
}>()

interface ConversationTargetSelection {
  target: string | 'new'
  source: 'ai' | 'user'
  confidence?: number
}

const emit = defineEmits<{
  select: [selection: ConversationTargetSelection]
  'clear-ai': []
  'clear-target': []
  'enable-auto': []
  'routing-change': [routing: boolean]
  'auto-mode-change': [automatic: boolean]
  'ai-status-hover': []
  'ai-status-leave': []
  'route-status': [status: RouteStatus]
}>()

const routeTrace = ref<ConversationRouteTrace>()
/** 流式期间实时累积的 thinking/content（供 AgentDialog 路由小窗渲染）。 */
const liveThinking = ref('')
const liveContent = ref('')
const routeError = ref('')
let requestVersion = 0
const routing = ref(false)
const autoMode = ref(props.routingEnabled)
/** 用户手动半选（待再次点击锁定的候选会话）。与 AI 推荐共同构成「半选」视觉态。 */
const manualHalfId = ref<string>()

function setRouting(value: boolean): void {
  if (routing.value === value) return
  routing.value = value
  emit('routing-change', value)
}

function resetRouteState(): void {
  routeTrace.value = undefined
  liveThinking.value = ''
  liveContent.value = ''
  routeError.value = ''
}

function setAutoMode(value: boolean): void {
  if (autoMode.value === value) return
  autoMode.value = value
  emit('auto-mode-change', value)
}

function clearAiSelection(): void {
  if (props.selectedSource === 'ai') emit('clear-ai')
}

function visualStateOf(chatId: string): ConversationTargetVisualState {
  return conversationTargetVisualState(
    chatId,
    props.selected,
    props.selectedSource,
    [],
    manualHalfId.value,
  )
}

function cycleStateOf(chatId: string): TargetCycleState {
  const visualState = visualStateOf(chatId)
  if (visualState === 'manual' || visualState === 'ai-selected') return 'full'
  if (visualState === 'recommended') return 'half'
  return 'idle'
}

/** 停止自动路由并清空推荐，进入用户操作分支。 */
function beginManualControl(): void {
  requestVersion += 1
  setAutoMode(false)
  resetRouteState()
  setRouting(false)
}

/** 未选 → 半选：标记为候选，等待再次点击锁定，并清掉此前目标以避免冲突。 */
function enterManualHalf(target: string): void {
  manualHalfId.value = target
  beginManualControl()
  if (props.selected) emit('clear-target')
}

/** 半选 → 选中：锁定为用户选择并提交目标。 */
function commitUserSelection(target: string | 'new'): void {
  manualHalfId.value = undefined
  beginManualControl()
  emit('select', { target, source: 'user' })
}

/** 选中 → 取消：回到 AI 自动路由；无路由时清空选择。 */
function cancelToAuto(): void {
  manualHalfId.value = undefined
  if (props.routingEnabled) {
    selectAuto()
    return
  }
  beginManualControl()
  emit('enable-auto')
}

/** 单击循环一档：未选→指定→半指定→取消（未选）。 */
function selectByUser(target: string | 'new'): void {
  if (target === 'new') {
    commitUserSelection('new')
    return
  }
  const next = nextTargetCycleState(cycleStateOf(target))
  if (next === 'half') enterManualHalf(target)
  else if (next === 'full') commitUserSelection(target)
  else cancelToAuto()
}

function selectAuto(): void {
  if (!props.routingEnabled) return
  requestVersion += 1
  setAutoMode(true)
  resetRouteState()
  emit('enable-auto')
}

const orderedSessions = computed(() => {
  const sessions = [...props.sessions]
  if (
    props.selected &&
    props.selected !== 'new' &&
    !sessions.some((session) => session.chatId === props.selected)
  ) {
    const traced = routeTrace.value?.context.candidates.find(
      (candidate) => candidate.chatId === props.selected,
    )
    if (traced) {
      sessions.push({
        chatId: traced.chatId,
        preview: traced.preview,
        lastUserActivityAt: traced.lastUserActivityAt,
        createdAt: traced.lastUserActivityAt,
      })
    }
  }
  return visibleConversationTargetSessions(sessions, props.selected)
})

function labelOf(session: ChatSummary): string {
  return session.preview?.trim() || `会话 ${new Date(session.createdAt ?? 0).toLocaleString()}`
}

/** 会话标签拆段：text 原文、`[[command:/x]]`→`/x`、`[[role:@x]]`→`@x`，供紧凑 tag 渲染。 */
function labelSegments(session: ChatSummary): CommandPromptSegment[] {
  return splitCommandPrompt(labelOf(session))
}

/**
 * 每个历史会话按钮的 DOM ref（ElPopover virtual-ref 锚定 hover tooltip）。
 * 用 virtual-triggering 而非包 wrapper，避免 tooltip 触发 span 破坏 .target-options 的 flex 布局。
 */
const buttonRefs = new Map<string, Ref<HTMLElement | null>>()
const newButtonRef = ref<HTMLElement | null>(null)
function buttonRefOf(chatId: string): Ref<HTMLElement | null> {
  let r = buttonRefs.get(chatId)
  if (!r) {
    r = ref(null)
    buttonRefs.set(chatId, r)
  }
  return r
}
function bindButtonRef(chatId: string): (el: Element | ComponentPublicInstance | null) => void {
  const r = buttonRefOf(chatId)
  return (el) => {
    r.value = el instanceof HTMLElement ? el : null
  }
}
function bindNewButtonRef(el: Element | ComponentPublicInstance | null): void {
  newButtonRef.value = el instanceof HTMLElement ? el : null
}

/** hover tooltip 状态行：完整状态描述。 */
function stateHintOf(session: ChatSummary): string {
  if (props.selected === session.chatId && props.selectedSource === 'user')
    return '已指定为本次发送目标'
  if (props.selected === session.chatId && props.selectedSource === 'ai')
    return 'AI 已选定为本次发送目标'
  if (visualStateOf(session.chatId) === 'recommended') {
    return '候选目标，再次点击锁定'
  }
  return '未选择'
}

/** 前置信息节点（不可选）：展示当前目标选择模式（全自动/半自动/手动），动态过程保留原文案。 */
const aiStatusLabel = computed(() => {
  if (props.selectedSource === 'user') return '手动选择'
  if (manualHalfId.value) return 'AI半自动选择'
  if (routeError.value) return 'AI 未确定目标，请手动选择'
  if (routing.value) return 'AI 选择会话中…'
  if (props.selectedSource === 'ai' && props.selected === 'new') return 'AI全自动选择'
  if (props.selectedSource === 'ai' && props.selected) return 'AI全自动选择'
  return props.routingEnabled ? 'AI全自动选择' : '手动选择'
})

const aiStatusIcon = computed(() => {
  if (props.selectedSource === 'user' || manualHalfId.value) return '✋'
  if (routing.value) return '⏳'
  if (routeError.value) return '⚠'
  if (props.selectedSource === 'ai' && props.selected) return '✨'
  return '🤖'
})

function showsAiTrace(target: string | 'new'): boolean {
  return !!routeTrace.value && props.selectedSource === 'ai' && props.selected === target
}

/** 会话创建时间（tooltip 展示）。 */
function timeOf(session: ChatSummary): string {
  return session.createdAt ? formatTime(session.createdAt) : ''
}

/** 外部选中目标变化（AI 自动选定 / 父级清空）时，若不再对应当前手动半选则清除半选态。
 * 例外：我们自己清掉「＋新会话」（selected:'new'→undefined）时保留本次历史会话半选，否则半选会被误清。 */
watch(
  () => props.selected,
  (selected, previous) => {
    if (!manualHalfId.value) return
    if (selected === manualHalfId.value) return
    if (previous === 'new' && selected === undefined) return
    manualHalfId.value = undefined
  },
)

/** routingEnabled 随 config 异步就绪后同步 autoMode，避免初始 false 将自动路由永久锁死。 */
watch(
  () => props.routingEnabled,
  (enabled) => {
    setAutoMode(enabled)
  },
)

/**
 * 由父级发送动作显式调用。输入阶段不请求路由；这里完成选择后，父级才会真正提交消息。
 */
async function routeForSend(draft: string): Promise<ConversationTargetSelection | undefined> {
  const prompt = draft.trim()
  if (!prompt || !props.routingEnabled || !autoMode.value || routing.value) return undefined

  const version = ++requestVersion
  clearAiSelection()
  routeError.value = ''
  routeTrace.value = undefined
  liveThinking.value = ''
  liveContent.value = ''
  setRouting(true)
  emit('route-status', { routing: true, thinking: '', content: '' })
  try {
    const result = await agentApi.suggestConversationRouteStream(
      {
        presetId: props.presetId,
        draft: prompt,
        requestVersion: version,
      },
      (delta) => {
        if (version !== requestVersion) return
        liveThinking.value += delta.thinking
        liveContent.value += delta.content
        emit('route-status', {
          routing: true,
          thinking: liveThinking.value,
          content: liveContent.value,
        })
      },
    )
    if (version !== requestVersion || !autoMode.value || props.selectedSource === 'user') {
      return undefined
    }
    routeTrace.value = result.trace
    emit('route-status', {
      routing: false,
      trace: result.trace,
      thinking: liveThinking.value,
      content: liveContent.value,
    })
    const selection: ConversationTargetSelection = result.target.chatId
      ? { target: result.target.chatId, source: 'ai', confidence: result.target.confidence }
      : { target: 'new', source: 'ai', confidence: result.target.confidence }
    emit('select', selection)
    return selection
  } catch (error) {
    if (version !== requestVersion || !autoMode.value) return undefined
    clearAiSelection()
    routeTrace.value = undefined
    liveThinking.value = ''
    liveContent.value = ''
    routeError.value = '智能推荐暂不可用，请手动选择目标'
    emit('route-status', { routing: false, thinking: '', content: '' })
    console.warn('[ConversationTargetPicker] route suggestion failed:', error)
    return undefined
  } finally {
    if (version === requestVersion) setRouting(false)
  }
}

defineExpose({ routeForSend })

onBeforeUnmount(() => {
  requestVersion += 1
  resetRouteState()
  setRouting(false)
})
</script>

<template>
  <section class="target-picker" aria-label="选择消息目标">
    <div class="target-options">
      <template v-for="session in orderedSessions" :key="session.chatId">
        <el-popover
          :virtual-ref="buttonRefOf(session.chatId)"
          virtual-triggering
          trigger="hover"
          placement="top"
          :show-after="120"
          :hide-after="0"
          popper-class="target-tip"
        >
          <template #default>
            <div v-if="showsAiTrace(session.chatId) && routeTrace" class="target-tip is-trace">
              <div class="target-tip-state">本次 AI 会话选择</div>
              <div class="target-tip-section">
                <b>选择上下文</b>
                <p>{{ routeTrace.context.draft }}</p>
                <ul class="target-tip-candidates">
                  <li v-for="candidate in routeTrace.context.candidates" :key="candidate.chatId">
                    <code>{{ candidate.chatId }}</code>
                    <span>{{ candidate.preview || '（无历史消息）' }}</span>
                  </li>
                </ul>
              </div>
              <div class="target-tip-section">
                <b>AI 回复</b>
                <p>{{ routeTrace.response.content || '（无正文，直接调用工具）' }}</p>
              </div>
              <div class="target-tip-section is-tool">
                <b>{{ routeTrace.response.toolCall.name }}</b>
                <code>{{ JSON.stringify(routeTrace.response.toolCall.arguments) }}</code>
              </div>
            </div>
            <div v-else class="target-tip">
              <div class="target-tip-state">{{ stateHintOf(session) }}</div>
              <div class="target-tip-content">
                {{ session.preview?.trim() || '（无历史消息）' }}
              </div>
              <div class="target-tip-meta">
                <span v-if="timeOf(session)">{{ timeOf(session) }}</span>
              </div>
            </div>
          </template>
        </el-popover>
        <button
          :ref="bindButtonRef(session.chatId)"
          type="button"
          class="target-option"
          :disabled="routing"
          :class="{
            'is-selected': ['manual', 'ai-selected'].includes(visualStateOf(session.chatId)),
            'is-suggested': visualStateOf(session.chatId) === 'recommended',
          }"
          @click="selectByUser(session.chatId)"
        >
          <!-- 按钮仅展示截断标题（/命令、@角色 tag 保留）；选中/推荐态由边框底色区分，完整预览悬停可见 -->
          <span class="target-label">
            <template
              v-for="(segment, index) in labelSegments(session)"
              :key="`${segment.type}-${index}`"
            >
              <span v-if="segment.type === 'command'" class="target-label-tag is-command">{{
                segment.value
              }}</span>
              <span v-else-if="segment.type === 'role'" class="target-label-tag is-role">{{
                segment.value
              }}</span>
              <template v-else>
                <span class="target-label-text">{{ segment.value }}</span>
              </template>
            </template>
          </span>
        </button>
      </template>
      <el-popover
        v-if="showsAiTrace('new')"
        :virtual-ref="newButtonRef"
        virtual-triggering
        trigger="hover"
        placement="top"
        :show-after="120"
        :hide-after="0"
        popper-class="target-tip"
      >
        <template #default>
          <div v-if="routeTrace" class="target-tip is-trace">
            <div class="target-tip-state">本次 AI 会话选择</div>
            <div class="target-tip-section">
              <b>选择上下文</b>
              <p>{{ routeTrace.context.draft }}</p>
              <ul class="target-tip-candidates">
                <li v-for="candidate in routeTrace.context.candidates" :key="candidate.chatId">
                  <code>{{ candidate.chatId }}</code>
                  <span>{{ candidate.preview || '（无历史消息）' }}</span>
                </li>
              </ul>
            </div>
            <div class="target-tip-section">
              <b>AI 回复</b>
              <p>{{ routeTrace.response.content || '（无正文，直接调用工具）' }}</p>
            </div>
            <div class="target-tip-section is-tool">
              <b>{{ routeTrace.response.toolCall.name }}</b>
              <code>{{ JSON.stringify(routeTrace.response.toolCall.arguments) }}</code>
            </div>
          </div>
        </template>
      </el-popover>
      <button
        :ref="bindNewButtonRef"
        type="button"
        class="target-option is-new"
        :disabled="routing"
        :class="{ 'is-selected': selected === 'new' }"
        @click="selectByUser('new')"
      >
        <span class="target-label">＋新对话</span>
      </button>
      <!-- 行尾前置信息节点（不可选）：展示当前目标选择模式（AI全自动/AI半自动/手动） -->
      <div
        class="target-option is-info"
        role="status"
        aria-live="polite"
        :title="aiStatusLabel"
        @mouseenter="emit('ai-status-hover')"
        @mouseleave="emit('ai-status-leave')"
      >
        <span class="target-state" aria-hidden="true">{{ aiStatusIcon }}</span>
        <span class="target-label">{{ aiStatusLabel }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped lang="less">
.target-picker {
  min-width: 0;
  padding: 6px 0;
}
.target-options {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden; /* 禁滚动：节点收缩到 min-width，超出部分裁切 */
  padding: 1px;
}
.target-option {
  flex: 0 1 124px;
  min-width: 64px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 7px;
  overflow: hidden;
  text-align: left;
  border: 1px solid color-mix(in srgb, var(--ink) 13%, transparent);
  border-radius: 6px;
  background: color-mix(in srgb, var(--surface) 78%, transparent);
  color: var(--ink);
  cursor: pointer;
}
.target-option:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--accent) 42%, transparent);
  background: var(--surface-hover);
}
.target-option:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
.target-option.is-new {
  flex: 0 0 66px;
}
.target-option.is-info {
  flex: 0 0 auto; /* 不可收缩：状态文案（AI全自动/AI半自动/手动）必须完整显示，空间不足时压缩前面的待选按钮 */
  min-width: 0;
  margin-left: auto;
  border-style: dashed;
  border-color: color-mix(in srgb, var(--ink) 18%, transparent);
  background: color-mix(in srgb, var(--surface) 50%, transparent);
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  cursor: default;
}
.target-option.is-info:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--ink) 18%, transparent);
  background: color-mix(in srgb, var(--surface) 50%, transparent);
}
.target-option.is-suggested {
  border-style: dashed;
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}
.target-option.is-selected {
  border-style: solid;
  border-color: var(--accent);
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 10%, transparent);
}
.target-state {
  flex: none;
  color: var(--accent-ink);
  font-size: 8px;
  font-weight: 800;
}
.target-label {
  min-width: 0;
  max-width: 100%; /* 宽度自适应按钮：超宽省略，避免整行裁切无省略号 */
  display: inline-flex;
  align-items: baseline;
  gap: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 9.5px;
  font-weight: 650;
}
.target-label-text {
  /* 省略作用在文本 span 上：flex 容器自身的 text-overflow 不生效（裸文本是匿名 flex item），
     必须让文本段成为可收缩的 flex 项并在此省略。tag 保持 flex:none 不被压缩。 */
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.target-label-tag {
  flex: none;
  padding: 0 4px;
  border-radius: 4px;
  font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace;
  font-size: 8.5px;
  font-weight: 700;
  line-height: 1.5;
}
.target-label-tag.is-command {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--accent-ink);
}
.target-label-tag.is-role {
  background: rgba(70, 126, 202, 0.16);
  color: #2f6fae;
}
[data-theme='dark'] .target-label-tag.is-role {
  background: color-mix(in srgb, #3b82f6 24%, transparent);
  color: #93c5fd;
}
</style>

<!-- hover tooltip 内容（el-popper teleport 到 body，scoped 样式不命中，故独立非 scoped 块） -->
<style lang="less">
.target-tip {
  max-width: 320px;
  .target-tip-state {
    margin-bottom: 4px;
    font-size: 11px;
    font-weight: 800;
    color: var(--accent-ink);
  }
  .target-tip-content {
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--ink);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .target-tip-meta {
    display: flex;
    gap: 8px;
    margin-top: 6px;
    font-size: 10px;
    color: color-mix(in srgb, var(--ink) 55%, transparent);
  }
  &.is-trace {
    width: min(420px, calc(100vw - 40px));
    max-width: 420px;
    max-height: 420px;
    overflow: auto;
  }
  .target-tip-section {
    margin-top: 9px;
    padding-top: 8px;
    border-top: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  }
  .target-tip-section b {
    display: block;
    margin-bottom: 4px;
    font-size: 10.5px;
    color: var(--accent-ink);
  }
  .target-tip-section p {
    margin: 0;
    font-size: 11px;
    line-height: 1.5;
    color: var(--ink);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .target-tip-section.is-tool code {
    display: block;
    padding: 6px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--ink) 6%, transparent);
    white-space: pre-wrap;
    word-break: break-all;
    font-size: 10px;
  }
  .target-tip-candidates {
    display: grid;
    gap: 5px;
    max-height: 150px;
    margin: 5px 0 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }
  .target-tip-candidates li {
    display: grid;
    grid-template-columns: minmax(72px, auto) 1fr;
    gap: 7px;
    align-items: start;
    font-size: 10px;
    line-height: 1.4;
  }
  .target-tip-candidates code {
    color: color-mix(in srgb, var(--ink) 62%, transparent);
    word-break: break-all;
  }
  .target-tip-candidates span {
    color: var(--ink);
    word-break: break-word;
  }
}
</style>
