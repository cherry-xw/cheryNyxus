<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useInteractionsStore } from '@/stores'
import type { InteractionRecord } from '@/services/agentApi'

const props = defineProps<{ presetId?: string }>()
const emit = defineEmits<{
  tree: [rootChatId: string, sourceChatId?: string, interactionId?: string, anchorNodeId?: string]
}>()

const interactions = useInteractionsStore()
const scope = ref<'workspace' | 'all'>(props.presetId ? 'workspace' : 'all')
const section = ref<'pending' | 'activity'>('pending')
const submitError = ref('')
const drafts = reactive<Record<string, Record<string, { selectedLabels: string[]; freeText: string }>>>({})

const scoped = computed(() => {
  const source = section.value === 'pending' ? interactions.pending : interactions.activity
  if (scope.value === 'all' || !props.presetId) return source
  return source.filter((item) => item.presetId === props.presetId)
})

function payload(item: InteractionRecord): Record<string, unknown> {
  return item.payload ?? {}
}
function questionsOf(item: InteractionRecord): Array<{
  questionId: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}> {
  return Array.isArray(payload(item).questions)
    ? payload(item).questions as ReturnType<typeof questionsOf>
    : []
}
function draftOf(item: InteractionRecord, questionId: string) {
  const group = (drafts[item.interactionId] ??= {})
  return (group[questionId] ??= { selectedLabels: [], freeText: '' })
}
function toggleOption(item: InteractionRecord, questionId: string, label: string, multi: boolean): void {
  const draft = draftOf(item, questionId)
  if (!multi) {
    // 单选：点已选 → 清空（可取消）；未选 → 替换，并与「其他」互斥（清空 freeText）
    if (draft.selectedLabels.includes(label)) {
      draft.selectedLabels = []
    } else {
      draft.selectedLabels = [label]
      draft.freeText = ''
    }
  } else if (draft.selectedLabels.includes(label)) {
    draft.selectedLabels = draft.selectedLabels.filter((value) => value !== label)
  } else draft.selectedLabels.push(label)
}
/** 「其他补充」输入：手动双向绑定；单选模式下输入即清空已选选项（与选项互斥，单选二选一）。 */
function onOtherInput(
  item: InteractionRecord,
  questionId: string,
  event: Event,
): void {
  const draft = draftOf(item, questionId)
  draft.freeText = (event.target as HTMLInputElement).value
  const question = questionsOf(item).find((q) => q.questionId === questionId)
  if (question && !question.multiSelect && draft.freeText.trim()) draft.selectedLabels = []
}
function titleOf(item: InteractionRecord): string {
  if (item.kind === 'approval') return `确认 ${String(payload(item).senseName ?? '工具调用')}`
  const questions = questionsOf(item)
  return questions[0]?.header || questions[0]?.question || '回答 Agent 提问'
}
function statusOf(item: InteractionRecord): string {
  return {
    pending: '待处理', resolving: '处理中', blocked: '恢复失败',
    completed: '已完成', expired: '审批超时，未执行', cancelled: '已取消',
  }[item.status]
}
function timeOf(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleString() : ''
}
async function decide(item: InteractionRecord, action: 'accept' | 'reject'): Promise<void> {
  submitError.value = ''
  try { await interactions.decide(item, action) }
  catch (cause) { submitError.value = cause instanceof Error ? cause.message : '审批失败' }
}
async function answer(item: InteractionRecord): Promise<void> {
  submitError.value = ''
  const answers = questionsOf(item).map((question) => {
    const draft = draftOf(item, question.questionId)
    return {
      questionId: question.questionId,
      selectedLabels: [...draft.selectedLabels],
      ...(draft.freeText.trim() ? { freeText: draft.freeText.trim() } : {}),
      ...({ multiSelect: question.multiSelect } satisfies Record<string, boolean>),
    }
  })
  if (answers.some((answer) => answer.selectedLabels.length === 0 && !answer.freeText)) {
    submitError.value = '请完成全部问题后提交'
    return
  }
  // 单选强制「选项 or 其他」二选一，禁止并存（服务端会落库冲突答案）
  if (
    answers.some((answer) => !answer.multiSelect && answer.selectedLabels.length > 0 && answer.freeText)
  ) {
    submitError.value = '单选题请在选项与「其他补充」中二选一'
    return
  }
  const submit = answers.map(({ multiSelect, ...rest }) => rest)
  try { await interactions.answer(item, submit) }
  catch (cause) { submitError.value = cause instanceof Error ? cause.message : '回答失败' }
}

onMounted(() => void interactions.refresh().catch(() => undefined))
</script>

<template>
  <section class="interaction-inbox" aria-label="待处理交互">
    <div class="inbox-toolbar">
      <div class="segmented">
        <button type="button" :class="{ active: section === 'pending' }" @click="section = 'pending'">待处理 {{ interactions.pending.length }}</button>
        <button type="button" :class="{ active: section === 'activity' }" @click="section = 'activity'">最近活动</button>
      </div>
      <div class="segmented" v-if="presetId">
        <button type="button" :class="{ active: scope === 'workspace' }" @click="scope = 'workspace'">当前工作台</button>
        <button type="button" :class="{ active: scope === 'all' }" @click="scope = 'all'">全部</button>
      </div>
      <button type="button" class="refresh" :disabled="interactions.loading" @click="interactions.refresh()">↻</button>
    </div>

    <p v-if="submitError || interactions.error" class="error">{{ submitError || interactions.error }}</p>
    <div class="inbox-list">
      <article v-for="item in scoped" :key="item.interactionId" class="interaction-card" :class="`is-${item.status}`">
        <header>
          <span class="kind">{{ item.kind === 'approval' ? '需确认' : '需回答' }}</span>
          <strong>{{ titleOf(item) }}</strong>
          <small>{{ statusOf(item) }} · {{ timeOf(item.createdAt) }}</small>
        </header>

        <pre v-if="item.kind === 'approval'" class="arguments">{{ payload(item).arguments }}</pre>
        <div v-else class="questions">
          <fieldset v-for="question in questionsOf(item)" :key="question.questionId" :disabled="item.status !== 'pending'">
            <legend>{{ question.header || question.question }}</legend>
            <small v-if="question.header">{{ question.question }}</small>
            <div class="options">
              <button
                v-for="option in question.options" :key="option.label" type="button"
                :class="{ selected: draftOf(item, question.questionId).selectedLabels.includes(option.label) }"
                @click="toggleOption(item, question.questionId, option.label, question.multiSelect)"
              >
                <b>{{ option.label }}</b><span v-if="option.description">{{ option.description }}</span>
              </button>
            </div>
            <input
              :value="draftOf(item, question.questionId).freeText"
              placeholder="其他补充（可选）"
              @input="onOtherInput(item, question.questionId, $event)"
            />
          </fieldset>
        </div>

        <footer>
          <button type="button" class="locate" @click="emit('tree', item.rootChatId, item.chatId, item.interactionId, item.anchorNodeId)">在节点树中查看</button>
          <template v-if="section === 'pending' && item.kind === 'approval'">
            <button type="button" class="reject" :disabled="item.status === 'resolving'" @click="decide(item, 'reject')">拒绝</button>
            <button type="button" class="accept" :disabled="item.status === 'resolving'" @click="decide(item, 'accept')">{{ item.status === 'blocked' ? '重试并接受' : '接受' }}</button>
          </template>
          <button v-else-if="section === 'pending' && item.kind === 'question_batch'" type="button" class="accept" :disabled="item.status !== 'pending'" @click="answer(item)">提交回答</button>
        </footer>
      </article>
      <p v-if="scoped.length === 0" class="empty">{{ interactions.loading ? '正在加载…' : section === 'pending' ? '没有待处理交互' : '暂无最近活动' }}</p>
    </div>
  </section>
</template>

<style scoped lang="less">
.interaction-inbox { height:100%; min-height:280px; padding:12px 14px 16px; overflow:hidden; color:var(--ink); }
.inbox-toolbar,.segmented,article header,article footer { display:flex; align-items:center; gap:7px; }
.inbox-toolbar { justify-content:space-between; margin-bottom:10px; }
.segmented { padding:2px; border-radius:9px; background:color-mix(in srgb,var(--ink) 7%,transparent); }
.segmented button,.refresh { border:0; border-radius:7px; padding:5px 8px; background:transparent; color:color-mix(in srgb,var(--ink) 62%,transparent); font-size:10px; cursor:pointer; }
.segmented button.active { background:var(--surface); color:var(--ink); box-shadow:0 1px 4px color-mix(in srgb,var(--ink) 10%,transparent); }
.inbox-list { display:flex; flex-direction:column; gap:9px; max-height:min(62vh,580px); overflow:auto; }
.interaction-card { padding:11px; border:1px solid color-mix(in srgb,var(--ink) 12%,transparent); border-radius:12px; background:var(--surface); }
.interaction-card.is-blocked { border-color:#e59a35; }
article header { align-items:baseline; }
article header strong { flex:1; font-size:12px; }
article header small { color:color-mix(in srgb,var(--ink) 52%,transparent); font-size:8px; }
.kind { padding:3px 6px; border-radius:999px; background:color-mix(in srgb,#f6b73c 20%,var(--surface-soft)); color:#b45a16; font-size:9px; font-weight:800; }
.arguments { max-height:130px; margin:10px 0; padding:9px; overflow:auto; border-radius:8px; background:var(--surface-soft); white-space:pre-wrap; font-size:9px; }
fieldset { margin:10px 0; padding:9px; border:1px solid color-mix(in srgb,var(--ink) 10%,transparent); border-radius:9px; }
legend { padding:0 4px; font-size:11px; font-weight:700; }
fieldset>small { display:block; margin-bottom:7px; opacity:.65; }
.options { display:grid; gap:5px; }
.options button { display:grid; gap:2px; padding:7px; border:1px solid color-mix(in srgb,var(--ink) 13%,transparent); border-radius:8px; background:transparent; color:var(--ink); text-align:left; cursor:pointer; }
.options button.selected { border-color:#c98224; background:color-mix(in srgb,#f6b73c 13%,var(--surface)); }
.options span { font-size:9px; opacity:.6; }
input { box-sizing:border-box; width:100%; margin-top:6px; padding:7px; border:1px solid color-mix(in srgb,var(--ink) 12%,transparent); border-radius:7px; background:var(--surface); color:var(--ink); }
article footer { justify-content:flex-end; margin-top:9px; }
article footer button { padding:6px 10px; border:0; border-radius:8px; cursor:pointer; }
.locate { margin-right:auto; background:transparent; color:color-mix(in srgb,var(--ink) 65%,transparent); }
.reject { background:color-mix(in srgb,#e35a49 12%,var(--surface)); color:#b74438; }
.accept { background:#d88a26; color:white; }
.error { padding:7px; border-radius:8px; background:color-mix(in srgb,#e35a49 13%,var(--surface)); color:#b74438; font-size:10px; }
.empty { margin:48px 0; text-align:center; opacity:.5; font-size:11px; }
</style>
