<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useInteractionsStore, useTaskOverviewStore } from '@/application/public'
import type { InteractionRecord } from '@/application/backend/public'
import ApprovalSummary from '@/features/agent/cards/ApprovalSummary.vue'
import FileChangeDiff from '@/features/agent/cards/FileChangeDiff.vue'
import ParsedArgs from '@/features/agent/cards/ParsedArgs.vue'
import InteractionDecisionContext from '@/features/agent/attention/InteractionDecisionContext.vue'
import { createApprovalPresentation } from '@/utils/approvalPresentation'

const emit = defineEmits<{ locate: [item: InteractionRecord] }>()
const interactions = useInteractionsStore()
const overview = useTaskOverviewStore()
const activeId = ref<string>()
const now = ref(interactions.calibratedNow())
let countdownTimer: ReturnType<typeof setInterval> | undefined

interface PanelQuestion {
  questionId: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

interface QuestionDraft {
  selectedLabels: string[]
  optionNotes: Record<string, string>
  freeText: string
}

const drafts = reactive<Record<string, Record<string, QuestionDraft>>>({})
const pendingItems = computed(() => interactions.pending)
const activeItem = computed(
  () =>
    pendingItems.value.find((item) => item.interactionId === activeId.value) ??
    pendingItems.value[0],
)

const queueGroups = computed(() => {
  const groups = new Map<string, InteractionRecord[]>()
  for (const item of pendingItems.value) {
    const items = groups.get(item.rootChatId) ?? []
    items.push(item)
    groups.set(item.rootChatId, items)
  }
  return [...groups].map(([rootChatId, items]) => ({
    rootChatId,
    title: overview.tasksByRoot[rootChatId]?.title ?? `任务 ${rootChatId.slice(0, 8)}`,
    items,
  }))
})

watch(
  pendingItems,
  (items, previous = []) => {
    if (items.some((item) => item.interactionId === activeId.value)) return
    const previousIndex = previous.findIndex((item) => item.interactionId === activeId.value)
    const nextIndex = previousIndex < 0 ? 0 : Math.min(previousIndex, Math.max(0, items.length - 1))
    activeId.value = items[nextIndex]?.interactionId
  },
  { immediate: true },
)

function payload(item: InteractionRecord): Record<string, unknown> {
  return item.payload ?? {}
}

function questionsOf(item: InteractionRecord): PanelQuestion[] {
  return Array.isArray(payload(item).questions) ? (payload(item).questions as PanelQuestion[]) : []
}

function draftOf(item: InteractionRecord, questionId: string): QuestionDraft {
  const group = (drafts[item.interactionId] ??= {})
  return (group[questionId] ??= { selectedLabels: [], optionNotes: {}, freeText: '' })
}

function isSelected(item: InteractionRecord, questionId: string, label: string): boolean {
  return draftOf(item, questionId).selectedLabels.includes(label)
}

function toggleOption(item: InteractionRecord, question: PanelQuestion, label: string): void {
  const draft = draftOf(item, question.questionId)
  if (!question.multiSelect) {
    if (draft.selectedLabels.includes(label)) {
      draft.selectedLabels = []
      const notes = { ...draft.optionNotes }
      delete notes[label]
      draft.optionNotes = notes
      return
    }
    draft.selectedLabels = [label]
    draft.freeText = ''
    draft.optionNotes = draft.optionNotes[label] ? { [label]: draft.optionNotes[label] } : {}
    return
  }
  if (draft.selectedLabels.includes(label)) {
    draft.selectedLabels = draft.selectedLabels.filter((value) => value !== label)
    const notes = { ...draft.optionNotes }
    delete notes[label]
    draft.optionNotes = notes
  } else {
    draft.selectedLabels.push(label)
  }
}

function onOptionNoteInput(
  item: InteractionRecord,
  questionId: string,
  label: string,
  value: string,
): void {
  const draft = draftOf(item, questionId)
  draft.optionNotes = { ...draft.optionNotes, [label]: value }
}

function onOtherInput(item: InteractionRecord, question: PanelQuestion, value: string): void {
  const draft = draftOf(item, question.questionId)
  draft.freeText = value
  if (!question.multiSelect && draft.freeText.trim()) draft.selectedLabels = []
}

function questionAnswered(item: InteractionRecord, question: PanelQuestion): boolean {
  const draft = draftOf(item, question.questionId)
  if (draft.freeText.trim()) return true
  if (question.options.length === 0) return false
  return question.multiSelect ? draft.selectedLabels.length > 0 : draft.selectedLabels.length === 1
}

function canSubmit(item: InteractionRecord): boolean {
  const questions = questionsOf(item)
  return questions.length > 0 && questions.every((question) => questionAnswered(item, question))
}

function answeredQuestionCount(item: InteractionRecord): number {
  return questionsOf(item).filter((question) => questionAnswered(item, question)).length
}

function titleOf(item: InteractionRecord): string {
  if (item.kind === 'approval') {
    return createApprovalPresentation(payload(item).senseName, payload(item).arguments).title
  }
  const question = questionsOf(item)[0]
  return question?.header || question?.question || '回答 Agent 提问'
}

function agentOf(item: InteractionRecord): string {
  const context = payload(item).context
  if (!context || typeof context !== 'object') return '来源 Agent'
  const agent = (context as Record<string, unknown>).agent
  return typeof agent === 'string' && agent.trim() ? agent : '来源 Agent'
}

function statusOf(item: InteractionRecord): string {
  return {
    pending: '等待处理',
    resolving: '正在提交',
    blocked: '提交受阻，可重试',
    completed: '已完成',
    expired: '已超时',
    cancelled: '已取消',
  }[item.status]
}

function timeOf(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestamp)
}

function countdownOf(item: InteractionRecord): { show: boolean; expired: boolean; text: string } {
  if (item.kind !== 'approval' || typeof item.deadlineAt !== 'number') {
    return { show: false, expired: false, text: '' }
  }
  const remaining = Math.max(0, item.deadlineAt - now.value)
  const expired = remaining <= 0
  return { show: true, expired, text: expired ? '已超时' : `剩余 ${Math.ceil(remaining / 1000)}s` }
}

async function decide(item: InteractionRecord, action: 'accept' | 'reject'): Promise<void> {
  try {
    await interactions.decide(item, action)
  } catch {
    // The shared interaction store exposes the actionable error below.
  }
}

async function answer(item: InteractionRecord): Promise<void> {
  const answers = questionsOf(item).map((question) => {
    const draft = draftOf(item, question.questionId)
    const optionNotes = Object.fromEntries(
      draft.selectedLabels.flatMap((label) => {
        const note = draft.optionNotes[label]?.trim()
        return note ? [[label, note]] : []
      }),
    )
    return {
      questionId: question.questionId,
      selectedLabels: [...draft.selectedLabels],
      ...(Object.keys(optionNotes).length ? { optionNotes } : {}),
      ...(draft.freeText.trim() ? { freeText: draft.freeText.trim() } : {}),
    }
  })
  try {
    await interactions.answer(item, answers)
  } catch {
    // Validation and command failures are rendered from the shared store.
  }
}

onMounted(() => {
  void interactions.refresh().catch(() => undefined)
  countdownTimer = setInterval(() => {
    now.value = interactions.calibratedNow()
  }, 250)
})

onBeforeUnmount(() => {
  if (countdownTimer !== undefined) clearInterval(countdownTimer)
})
</script>

<template>
  <section class="attention-workspace" aria-label="等你处理工作区">
    <aside class="queue-pane">
      <header class="pane-head">
        <div>
          <small>ACTION QUEUE</small>
          <h2>需要你处理</h2>
          <p>这些操作必须由你确认或回答后，相关 Agent 才能继续。</p>
        </div>
        <button
          type="button"
          class="refresh"
          :disabled="interactions.loading"
          aria-label="刷新待处理操作"
          title="重新加载待处理操作"
          @click="interactions.refresh()"
        >
          ↻
        </button>
      </header>

      <p v-if="interactions.error" class="global-error" role="alert">{{ interactions.error }}</p>
      <div class="queue-list">
        <section v-for="group in queueGroups" :key="group.rootChatId" class="queue-group">
          <header>
            <strong>{{ group.title }}</strong>
            <span>{{ group.items.length }} 项</span>
          </header>
          <article
            v-for="item in group.items"
            :key="item.interactionId"
            class="queue-item"
            :class="{ selected: item.interactionId === activeItem?.interactionId }"
          >
            <button type="button" class="queue-select" @click="activeId = item.interactionId">
              <span class="kind" :class="`is-${item.kind}`">{{
                item.kind === 'approval' ? '需确认' : '需回答'
              }}</span>
              <b>{{ titleOf(item) }}</b>
              <small>{{ agentOf(item) }} · {{ statusOf(item) }}</small>
              <span
                v-if="countdownOf(item).show"
                class="countdown"
                :class="{ expired: countdownOf(item).expired }"
              >
                {{ countdownOf(item).text }}
              </span>
            </button>
            <button
              type="button"
              class="source-link"
              :aria-label="`查看“${titleOf(item)}”的原会话详情`"
              @click="emit('locate', item)"
            >
              查看原详情 ↗
            </button>
          </article>
        </section>

        <div v-if="pendingItems.length === 0" class="empty-state">
          <strong>{{
            interactions.loading ? '正在加载待处理操作…' : '现在没有需要你处理的操作'
          }}</strong>
          <p>新的审批或提问出现后会显示在这里，任务中心不会打断你当前查看的内容。</p>
        </div>
      </div>
    </aside>

    <section class="decision-pane">
      <template v-if="activeItem">
        <header class="decision-head">
          <div>
            <small>{{ activeItem.kind === 'approval' ? 'APPROVAL' : 'QUESTION' }}</small>
            <h2>{{ titleOf(activeItem) }}</h2>
            <p>
              {{
                activeItem.kind === 'approval'
                  ? '请核对操作目的、对象和影响，再决定是否允许 Agent 继续。'
                  : '请完成下面的必填问题；提交后，Agent 将使用你的回答继续任务。'
              }}
            </p>
          </div>
          <div class="decision-meta">
            <span>{{ statusOf(activeItem) }}</span>
            <time>{{ timeOf(activeItem.createdAt) }}</time>
            <b
              v-if="countdownOf(activeItem).show"
              :class="{ expired: countdownOf(activeItem).expired }"
            >
              {{ countdownOf(activeItem).text }}
            </b>
          </div>
        </header>

        <div class="decision-scroll">
          <InteractionDecisionContext :item="activeItem" />

          <template v-if="activeItem.kind === 'approval'">
            <ApprovalSummary
              :sense-name="payload(activeItem).senseName"
              :args="payload(activeItem).arguments"
            />
            <details class="technical-details">
              <summary>查看技术详情和完整参数</summary>
              <div>
                <ParsedArgs :args="payload(activeItem).arguments" embedded />
                <FileChangeDiff :args="payload(activeItem).arguments" embedded />
              </div>
            </details>
          </template>

          <section v-else class="question-list" aria-label="需要回答的问题">
            <fieldset
              v-for="(question, index) in questionsOf(activeItem)"
              :key="question.questionId"
              :disabled="activeItem.status !== 'pending'"
            >
              <legend>
                <span>问题 {{ index + 1 }}/{{ questionsOf(activeItem).length }}</span>
                {{ question.header || question.question }}
              </legend>
              <p v-if="question.header" class="question-copy">{{ question.question }}</p>
              <p class="answer-rule">
                {{
                  question.options.length === 0
                    ? '请输入回答后提交。'
                    : question.multiSelect
                      ? '可选择一项或多项，也可以补充自己的回答。'
                      : '请选择一项，或在“其他回答”中输入内容；两种方式二选一。'
                }}
              </p>
              <div v-if="question.options.length" class="options">
                <div v-for="option in question.options" :key="option.label" class="option-card">
                  <button
                    type="button"
                    :class="{ selected: isSelected(activeItem, question.questionId, option.label) }"
                    :aria-pressed="isSelected(activeItem, question.questionId, option.label)"
                    @click="toggleOption(activeItem, question, option.label)"
                  >
                    <span aria-hidden="true">{{
                      isSelected(activeItem, question.questionId, option.label) ? '✓' : ''
                    }}</span>
                    <b>{{ option.label }}</b>
                    <small v-if="option.description">{{ option.description }}</small>
                  </button>
                  <label
                    v-if="isSelected(activeItem, question.questionId, option.label)"
                    class="option-note"
                  >
                    <span>补充这个选项的说明（可选）</span>
                    <el-input
                      :model-value="
                        draftOf(activeItem, question.questionId).optionNotes[option.label] ?? ''
                      "
                      :disabled="activeItem.status !== 'pending'"
                      aria-label="补充这个选项的说明（可选）"
                      @update:model-value="
                        onOptionNoteInput(activeItem, question.questionId, option.label, $event)
                      "
                    />
                  </label>
                </div>
              </div>
              <label class="other-answer">
                <span>{{ question.options.length ? '其他回答' : '你的回答' }}</span>
                <el-input
                  type="textarea"
                  :autosize="{ minRows: 3, maxRows: 8 }"
                  :model-value="draftOf(activeItem, question.questionId).freeText"
                  :disabled="activeItem.status !== 'pending'"
                  :aria-label="question.options.length ? '其他回答' : '你的回答'"
                  :placeholder="
                    question.options.length ? '填写选项之外的回答（可选）' : '请输入回答'
                  "
                  @update:model-value="onOtherInput(activeItem, question, $event)"
                />
              </label>
              <p
                v-if="
                  interactions.questionErrorsById[activeItem.interactionId]?.[question.questionId]
                "
                class="object-error"
                role="alert"
              >
                {{
                  interactions.questionErrorsById[activeItem.interactionId]?.[question.questionId]
                    ?.message
                }}
              </p>
            </fieldset>
          </section>

          <p
            v-if="interactions.errorsById[activeItem.interactionId]"
            class="object-error"
            role="alert"
          >
            {{ interactions.errorsById[activeItem.interactionId]?.message }}
          </p>
        </div>

        <footer class="action-bar">
          <button type="button" class="source" @click="emit('locate', activeItem)">
            查看原会话详情 ↗
          </button>
          <template v-if="activeItem.kind === 'approval'">
            <span>选择后会立即提交给等待中的 Agent。</span>
            <button
              type="button"
              class="reject"
              :disabled="activeItem.status === 'resolving'"
              @click="decide(activeItem, 'reject')"
            >
              拒绝
            </button>
            <button
              type="button"
              class="accept"
              :disabled="activeItem.status === 'resolving'"
              @click="decide(activeItem, 'accept')"
            >
              {{ activeItem.status === 'blocked' ? '重试并接受' : '接受并继续' }}
            </button>
          </template>
          <template v-else>
            <span>
              已完成 {{ answeredQuestionCount(activeItem) }}/{{ questionsOf(activeItem).length }} 题
            </span>
            <button
              type="button"
              class="accept"
              :disabled="activeItem.status !== 'pending' || !canSubmit(activeItem)"
              @click="answer(activeItem)"
            >
              提交回答并继续
            </button>
          </template>
        </footer>
      </template>

      <div v-else class="decision-empty">
        <strong>没有待处理详情</strong>
        <p>当 Agent 需要你的确认或回答时，这里会展示原因、影响和完成操作所需的信息。</p>
      </div>
    </section>
  </section>
</template>

<style scoped lang="less" src="./TaskCenterAttentionWorkspace.styles.less"></style>
