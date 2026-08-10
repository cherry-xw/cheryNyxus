<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { agentApi, type ChatSummary } from '@/services/agentApi'
import {
  acceptedRouteCandidates,
  automaticRouteCandidate,
  canRequestAutomaticRoute,
  conversationTargetVisualState,
  nextTargetCycleState,
  type ConversationTargetVisualState,
  type TargetCycleState,
} from './conversationTargetRouting'
import {
  splitCommandPrompt,
  type CommandPromptSegment,
} from '../composables/commands'

const props = defineProps<{
  presetId: string
  draft: string
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
}>()
const suggestedIds = ref<string[]>([])
const reasons = ref<Record<string, string>>({})
const routeError = ref('')
let timer: ReturnType<typeof setTimeout> | undefined
let requestVersion = 0
const routing = ref(false)
const autoMode = ref(props.routingEnabled)
const autoRequestNonce = ref(0)
/** 用户手动半选（待再次点击锁定的候选会话）。与 AI 推荐共同构成「半选」视觉态。 */
const manualHalfId = ref<string>()

function setRouting(value: boolean): void {
  if (routing.value === value) return
  routing.value = value
  emit('routing-change', value)
}

function clearAiSelection(): void {
  if (props.selectedSource === 'ai') emit('clear-ai')
}

function visualStateOf(chatId: string): ConversationTargetVisualState {
  return conversationTargetVisualState(
    chatId,
    props.selected,
    props.selectedSource,
    suggestedIds.value,
    manualHalfId.value,
  )
}

function cycleStateOf(chatId: string): TargetCycleState {
  if (visualStateOf(chatId) === 'manual') return 'full'
  if (visualStateOf(chatId) === 'recommended') return 'half'
  return 'idle'
}

/** 停止自动路由并清空推荐，进入用户操作分支。 */
function beginManualControl(): void {
  requestVersion += 1
  if (timer) clearTimeout(timer)
  autoMode.value = false
  routeError.value = ''
  suggestedIds.value = []
  reasons.value = {}
  setRouting(false)
}

/** 未选 → 半选：标记为候选，等待再次点击锁定。半选历史会话时，清掉此前选中的「＋新会话」，避免冲突。 */
function enterManualHalf(target: string): void {
  manualHalfId.value = target
  beginManualControl()
  if (props.selected === 'new') emit('clear-target')
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

/** 单击循环一档：未选→半选→选中→取消（未选）。 */
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
  if (timer) clearTimeout(timer)
  autoMode.value = true
  autoRequestNonce.value += 1
  routeError.value = ''
  emit('enable-auto')
}

const orderedSessions = computed(() => {
  const byId = new Map(props.sessions.map((session) => [session.chatId, session]))
  const routed = suggestedIds.value.flatMap((id) => {
    const session = byId.get(id)
    if (!session) return []
    byId.delete(id)
    return [session]
  })
  return [
    ...routed,
    ...[...byId.values()].sort(
      (a, b) =>
        (b.lastUserActivityAt ?? b.createdAt ?? 0) -
        (a.lastUserActivityAt ?? a.createdAt ?? 0),
    ),
  ].slice(0, 3)
})

function labelOf(session: ChatSummary): string {
  return session.preview?.trim() || `会话 ${new Date(session.createdAt ?? 0).toLocaleString()}`
}

/** 会话标签拆段：text 原文、`[[command:/x]]`→`/x`、`[[role:@x]]`→`@x`，供紧凑 tag 渲染。 */
function labelSegments(session: ChatSummary): CommandPromptSegment[] {
  return splitCommandPrompt(labelOf(session))
}

/** 前置信息节点（不可选）：反映当前目标选择状态，内容随用户操作联动。 */
const aiStatusLabel = computed(() => {
  if (props.selectedSource === 'user') return '已手动选中会话，再次点击可取消'
  if (manualHalfId.value) return '已半选会话，再次点击锁定'
  if (routeError.value) return 'AI 未确定目标，请手动选择'
  if (routing.value) return 'AI 选择中…'
  if (props.selectedSource === 'ai' && props.selected !== 'new') return 'AI 已推荐发送目标'
  return props.routingEnabled ? '未手选时由 AI 自动选择' : '请选择发送目标'
})

const aiStatusIcon = computed(() => {
  if (props.selectedSource === 'user' || manualHalfId.value) return '✋'
  if (routing.value) return '⏳'
  if (routeError.value) return '⚠'
  if (props.selectedSource === 'ai' && props.selected !== 'new') return '✨'
  return '🤖'
})

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

watch(
  () => [props.draft, props.routingEnabled, autoMode.value, autoRequestNonce.value] as const,
  ([draft, enabled, automatic]) => {
    if (timer) clearTimeout(timer)
    const version = ++requestVersion
    if (!canRequestAutomaticRoute(automatic, enabled, draft)) {
      setRouting(false)
      routeError.value = ''
      if (automatic && (!props.selected || props.selectedSource === 'ai')) {
        clearAiSelection()
        suggestedIds.value = []
        reasons.value = {}
      }
      return
    }
    clearAiSelection()
    setRouting(true)
    timer = setTimeout(async () => {
      routeError.value = ''
      try {
        const result = await agentApi.suggestConversationRoute({
          presetId: props.presetId,
          draft,
          requestVersion: version,
        })
        if (version !== requestVersion || props.selectedSource === 'user') return
        const accepted = acceptedRouteCandidates(result.candidates)
        suggestedIds.value = accepted.map((candidate) => candidate.chatId!)
        reasons.value = Object.fromEntries(
          accepted.map((candidate) => [candidate.chatId!, candidate.reason]),
        )
        const automatic = automaticRouteCandidate(accepted)
        if (automatic?.chatId) {
          emit('select', {
            target: automatic.chatId,
            source: 'ai',
            confidence: automatic.confidence,
          })
        } else {
          routeError.value = 'AI 未找到明确目标，请手动选择'
        }
      } catch (error) {
        if (version !== requestVersion || !autoMode.value) return
        clearAiSelection()
        routeError.value = '智能推荐暂不可用，请手动选择目标'
        console.warn('[ConversationTargetPicker] route suggestion failed:', error)
      } finally {
        if (version === requestVersion) setRouting(false)
      }
    }, 400)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  requestVersion += 1
  if (timer) clearTimeout(timer)
  setRouting(false)
})
</script>

<template>
  <section class="target-picker" aria-label="选择消息目标">
    <div class="target-options">
      <button
        v-for="session in orderedSessions"
        :key="session.chatId"
        type="button"
        class="target-option"
        :class="{
          'is-selected': visualStateOf(session.chatId) === 'manual',
          'is-suggested': visualStateOf(session.chatId) === 'recommended',
        }"
        :title="reasons[session.chatId] || session.preview"
        @click="selectByUser(session.chatId)"
      >
        <span v-if="selected === session.chatId && selectedSource === 'user'" class="target-state">✓</span>
        <span
          v-else-if="visualStateOf(session.chatId) === 'recommended'"
          class="target-state"
          >{{ suggestedIds.includes(session.chatId) ? 'AI 推荐' : '半选' }}</span
        >
        <span class="target-label">
          <template
            v-for="(segment, index) in labelSegments(session)"
            :key="`${segment.type}-${index}`"
          >
            <span
              v-if="segment.type === 'command'"
              class="target-label-tag is-command"
              >{{ segment.value }}</span
            >
            <span v-else-if="segment.type === 'role'" class="target-label-tag is-role">{{
              segment.value
            }}</span>
            <template v-else>{{ segment.value }}</template>
          </template>
        </span>
      </button>
      <button
        type="button"
        class="target-option is-new"
        :class="{ 'is-selected': selected === 'new' }"
        @click="selectByUser('new')"
      >
        <span v-if="selected === 'new'" class="target-state">✓</span>
        <span class="target-label">＋新对话</span>
      </button>
      <div
        class="target-option is-info"
        role="status"
        aria-live="polite"
        :title="aiStatusLabel"
      >
        <span class="target-state" aria-hidden="true">{{ aiStatusIcon }}</span>
        <span class="target-label">{{ aiStatusLabel }}</span>
      </div>
    </div>
  </section>
</template>

<style scoped lang="less">
.target-picker { min-width:0; padding:6px 0; }
.target-options { display:flex; align-items:center; gap:4px; min-width:0; overflow-x:auto; padding:1px; scrollbar-width:none; }
.target-options::-webkit-scrollbar { display:none; }
.target-option { flex:0 1 124px; min-width:64px; height:26px; display:inline-flex; align-items:center; gap:4px; padding:3px 7px; overflow:hidden; text-align:left; border:1px solid color-mix(in srgb, var(--ink) 13%, transparent); border-radius:6px; background:color-mix(in srgb, var(--surface) 78%, transparent); color:var(--ink); cursor:pointer; }
.target-option:hover:not(:disabled) { border-color:color-mix(in srgb, var(--accent) 42%, transparent); background:var(--surface-hover); }
.target-option:disabled { cursor:not-allowed; opacity:.45; }
.target-option.is-new { flex:0 0 66px; }
.target-option.is-info { flex:0 1 auto; min-width:0; margin-left:auto; border-style:dashed; border-color:color-mix(in srgb, var(--ink) 18%, transparent); background:color-mix(in srgb, var(--surface) 50%, transparent); color:color-mix(in srgb, var(--ink) 55%, transparent); cursor:default; }
.target-option.is-info:hover:not(:disabled) { border-color:color-mix(in srgb, var(--ink) 18%, transparent); background:color-mix(in srgb, var(--surface) 50%, transparent); }
.target-option.is-suggested { border-style:dashed; border-color:var(--accent); background:color-mix(in srgb, var(--accent) 7%, transparent); }
.target-option.is-selected { border-style:solid; border-color:var(--accent); background:color-mix(in srgb, var(--accent) 14%, transparent); box-shadow:0 0 0 1px color-mix(in srgb, var(--accent) 10%, transparent); }
.target-state { flex:none; color:var(--accent-ink); font-size:8px; font-weight:800; }
.target-label { min-width:0; display:inline-flex; align-items:baseline; gap:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:9.5px; font-weight:650; }
.target-label-tag { flex:none; padding:0 4px; border-radius:4px; font-family:ui-monospace,'SFMono-Regular',Menlo,Consolas,monospace; font-size:8.5px; font-weight:700; line-height:1.5; }
.target-label-tag.is-command { background:color-mix(in srgb, var(--accent) 18%, transparent); color:var(--accent-ink); }
.target-label-tag.is-role { background:rgba(70,126,202,.16); color:#2f6fae; }
[data-theme='dark'] .target-label-tag.is-role { background:color-mix(in srgb, #3b82f6 24%, transparent); color:#93c5fd; }
</style>
