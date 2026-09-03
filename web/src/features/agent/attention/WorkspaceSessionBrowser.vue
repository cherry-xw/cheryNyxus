<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useAgentsStore, useInteractionsStore } from '@/application/public'
import type { InteractionRecord } from '@/application/backend/public'
import ApprovalSummary from '@/features/agent/cards/ApprovalSummary.vue'
import ParsedArgs from '@/features/agent/cards/ParsedArgs.vue'
import FileChangeDiff from '@/features/agent/cards/FileChangeDiff.vue'
import { createApprovalPresentation } from '@/utils/approvalPresentation'

const props = withDefaults(defineProps<{ presetId?: string; native?: boolean }>(), {
  native: false,
})
const emit = defineEmits<{
  tree: [rootChatId: string, sourceChatId?: string, interactionId?: string, anchorNodeId?: string]
}>()

const agents = useAgentsStore()
const interactions = useInteractionsStore()
const scope = ref<'workspace' | 'all'>(props.presetId ? 'workspace' : 'all')
const section = ref<'pending' | 'activity'>('pending')
const drafts = reactive<
  Record<
    string,
    Record<
      string,
      { selectedLabels: string[]; optionNotes: Record<string, string>; freeText: string }
    >
  >
>({})
/** 审批倒计时驱动：now 每 250ms 刷新，重算各卡剩余秒。 */
const now = ref(Date.now())
let countdownTimer: ReturnType<typeof setInterval> | undefined

const scoped = computed(() => {
  const source = section.value === 'pending' ? interactions.pending : interactions.activity
  if (scope.value === 'all' || !props.presetId) return source
  return source.filter((item) => item.presetId === props.presetId)
})

// ── native 整窗模式：按 rootChatId 会话分组（native 定位"待处理指向谁"） ──
interface PendingGroup {
  id: string
  name: string
  items: InteractionRecord[]
}
/** 会话名解析：pet 名 → 会话 summary 预设名 → 兜底「会话」。 */
function nameOfRoot(rootChatId: string): string {
  const pet = agents.petForChat(rootChatId)
  if (pet?.name) return pet.name
  const summary = agents.summaryForChat(rootChatId)
  return summary?.preset ?? summary?.presetId ?? '会话'
}
const groups = computed<PendingGroup[]>(() => {
  if (!props.native) return []
  const byRoot = new Map<string, InteractionRecord[]>()
  for (const item of scoped.value) {
    const list = byRoot.get(item.rootChatId) ?? []
    list.push(item)
    byRoot.set(item.rootChatId, list)
  }
  return (
    [...byRoot.entries()]
      .map(([rootChatId, items]) => ({ id: rootChatId, name: nameOfRoot(rootChatId), items }))
      // 按组内最早 createdAt 升序：先发起的会话组在前，重点（等待最久）靠上
      .sort(
        (a, b) =>
          Math.min(...a.items.map((i) => i.createdAt)) -
          Math.min(...b.items.map((i) => i.createdAt)),
      )
  )
})
/** 统一渲染源：native 用分组；非 native 保持单列表现状（单组无头）。 */
const displayGroups = computed<PendingGroup[]>(() =>
  props.native ? groups.value : [{ id: '__all', name: '', items: scoped.value }],
)
// 分组定位：导航 chip / 分组头点击 → 滚动到对应分组
const groupEls = new Map<string, HTMLElement>()
function bindGroupEl(id: string, el: unknown): void {
  if (el instanceof HTMLElement) groupEls.set(id, el)
  else groupEls.delete(id)
}
const listEl = ref<HTMLElement | null>(null)
function scrollToGroup(id: string): void {
  groupEls.get(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
function scrollListTop(): void {
  listEl.value?.scrollTo({ top: 0, behavior: 'smooth' })
}

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
    ? (payload(item).questions as ReturnType<typeof questionsOf>)
    : []
}
function draftOf(item: InteractionRecord, questionId: string) {
  const group = (drafts[item.interactionId] ??= {})
  return (group[questionId] ??= { selectedLabels: [], optionNotes: {}, freeText: '' })
}
function toggleOption(
  item: InteractionRecord,
  questionId: string,
  label: string,
  multi: boolean,
): void {
  const draft = draftOf(item, questionId)
  if (!multi) {
    // 单选：点已选 → 清空（可取消）；未选 → 替换，并与「其他」互斥（清空 freeText）
    if (draft.selectedLabels.includes(label)) {
      draft.selectedLabels = []
      const { [label]: _removed, ...rest } = draft.optionNotes
      draft.optionNotes = rest
    } else {
      draft.selectedLabels = [label]
      draft.freeText = ''
      // 单选切选项：丢弃其他选项的补充描述
      draft.optionNotes = {
        ...(draft.optionNotes[label] ? { [label]: draft.optionNotes[label] } : {}),
      }
    }
  } else if (draft.selectedLabels.includes(label)) {
    draft.selectedLabels = draft.selectedLabels.filter((value) => value !== label)
    const { [label]: _removed, ...rest } = draft.optionNotes
    draft.optionNotes = rest
  } else draft.selectedLabels.push(label)
}
/** 某选项的补充描述输入（仅选中选项可编辑）。 */
function onOptionNoteInput(
  item: InteractionRecord,
  questionId: string,
  label: string,
  event: Event,
): void {
  const draft = draftOf(item, questionId)
  draft.optionNotes = { ...draft.optionNotes, [label]: (event.target as HTMLInputElement).value }
}
/** 「其他补充」输入：手动双向绑定；单选模式下输入即清空已选选项（与选项互斥，单选二选一）。 */
function onOtherInput(item: InteractionRecord, questionId: string, event: Event): void {
  const draft = draftOf(item, questionId)
  draft.freeText = (event.target as HTMLInputElement).value
  const question = questionsOf(item).find((q) => q.questionId === questionId)
  if (question && !question.multiSelect && draft.freeText.trim()) draft.selectedLabels = []
}
function titleOf(item: InteractionRecord): string {
  if (item.kind === 'approval')
    return createApprovalPresentation(payload(item).senseName, payload(item).arguments).title
  const questions = questionsOf(item)
  return questions[0]?.header || questions[0]?.question || '回答 Agent 提问'
}

/** 审批倒计时：approval 且带 deadlineAt 时返回剩余毫秒与是否超时；否则 total=0（不显示）。 */
function countdownOf(item: InteractionRecord): {
  total: number
  remaining: number
  expired: boolean
} {
  const deadline = item.deadlineAt
  if (item.kind !== 'approval' || typeof deadline !== 'number') {
    return { total: 0, remaining: 0, expired: false }
  }
  const remaining = Math.max(0, deadline - now.value)
  return { total: deadline, remaining, expired: remaining <= 0 }
}
function statusOf(item: InteractionRecord): string {
  return {
    pending: '待处理',
    resolving: '处理中',
    blocked: '恢复失败',
    completed: '已完成',
    expired: '审批超时，未执行',
    cancelled: '已取消',
  }[item.status]
}
function timeOf(timestamp?: number): string {
  return timestamp ? new Date(timestamp).toLocaleString() : ''
}
async function decide(item: InteractionRecord, action: 'accept' | 'reject'): Promise<void> {
  try {
    await interactions.decide(item, action)
  } catch {
    // The shared store binds the error to this interaction.
  }
}
/** 提交可点判定：单选恰好 1 项或有「其他补充」输入；多选 ≥1。无选择/输入时提交按钮禁用（灰）。 */
async function answer(item: InteractionRecord): Promise<void> {
  const answers = questionsOf(item).map((question) => {
    const draft = draftOf(item, question.questionId)
    const notes: Record<string, string> = {}
    for (const label of draft.selectedLabels) {
      const note = draft.optionNotes[label]?.trim()
      if (note) notes[label] = note
    }
    return {
      questionId: question.questionId,
      selectedLabels: [...draft.selectedLabels],
      ...(Object.keys(notes).length ? { optionNotes: notes } : {}),
      ...(draft.freeText.trim() ? { freeText: draft.freeText.trim() } : {}),
      ...({ multiSelect: question.multiSelect } satisfies Record<string, boolean>),
    }
  })
  // 丢弃 multiSelect 哨兵字段后提交（显式构造，避免解构未用变量）
  const submit = answers.map((answer) => ({
    questionId: answer.questionId,
    selectedLabels: answer.selectedLabels,
    ...(answer.optionNotes !== undefined ? { optionNotes: answer.optionNotes } : {}),
    ...(answer.freeText !== undefined ? { freeText: answer.freeText } : {}),
  }))
  try {
    await interactions.answer(item, submit)
  } catch {
    // Per-question and per-interaction errors are rendered from the shared store.
  }
}

onMounted(() => {
  void interactions.refresh().catch(() => undefined)
  countdownTimer = setInterval(() => {
    now.value = Date.now()
  }, 250)
})
onBeforeUnmount(() => {
  if (countdownTimer !== undefined) clearInterval(countdownTimer)
})
</script>

<template>
  <section class="interaction-inbox" :class="{ 'is-native': native }" aria-label="待处理交互">
    <div class="inbox-toolbar">
      <div class="segmented">
        <button
          type="button"
          :class="{ active: section === 'pending' }"
          @click="section = 'pending'"
        >
          待处理 {{ interactions.pending.length }}
        </button>
        <button
          type="button"
          :class="{ active: section === 'activity' }"
          @click="section = 'activity'"
        >
          最近活动
        </button>
      </div>
      <div v-if="presetId" class="segmented">
        <button
          type="button"
          :class="{ active: scope === 'workspace' }"
          @click="scope = 'workspace'"
        >
          当前工作台
        </button>
        <button type="button" :class="{ active: scope === 'all' }" @click="scope = 'all'">
          全部
        </button>
      </div>
      <button
        type="button"
        class="refresh"
        :disabled="interactions.loading"
        @click="interactions.refresh()"
      >
        ↻
      </button>
    </div>

    <!-- native 分组导航：每会话一个 chip，点击滚动定位到对应分组；「全部」回列表顶部 -->
    <nav v-if="native && groups.length > 1" class="inbox-nav" aria-label="待处理会话导航">
      <button type="button" class="nav-chip" @click="scrollListTop">全部</button>
      <button
        v-for="g in groups"
        :key="g.id"
        type="button"
        class="nav-chip"
        @click="scrollToGroup(g.id)"
      >
        <span class="nav-chip-name">{{ g.name }}</span
        ><b>{{ g.items.length }}</b>
      </button>
    </nav>

    <p v-if="interactions.error" class="error">
      {{ interactions.error }}
    </p>
    <div ref="listEl" class="inbox-list">
      <section
        v-for="group in displayGroups"
        :key="group.id"
        :ref="native ? (el) => bindGroupEl(group.id, el) : undefined"
        class="inbox-group"
      >
        <h4
          v-if="native"
          class="group-head"
          title="滚动定位到本会话"
          @click="scrollToGroup(group.id)"
        >
          {{ group.name }}<span class="group-count">{{ group.items.length }}</span>
        </h4>
        <article
          v-for="item in group.items"
          :key="item.interactionId"
          class="interaction-card"
          :class="`is-${item.status}`"
        >
          <header>
            <span class="kind" :class="item.kind === 'approval' ? 'is-approval' : 'is-question'">{{
              item.kind === 'approval' ? '需确认' : '需回答'
            }}</span>
            <strong>{{ titleOf(item) }}</strong>
            <small>
              {{ statusOf(item) }} · {{ timeOf(item.createdAt) }}
              <!-- 审批倒计时：后端 deadlineAt，归零变红提示超时。 -->
              <template v-if="countdownOf(item).total">
                <span v-if="countdownOf(item).expired" class="countdown is-expired">已超时</span>
                <span v-else class="countdown"
                  >剩余 {{ Math.ceil(countdownOf(item).remaining / 1000) }}s</span
                >
              </template>
            </small>
          </header>

          <template v-if="item.kind === 'approval'">
            <ApprovalSummary
              :sense-name="payload(item).senseName"
              :args="payload(item).arguments"
            />
            <ParsedArgs :args="payload(item).arguments" title="完整操作参数" />
            <FileChangeDiff :args="payload(item).arguments" />
          </template>
          <div v-else class="questions">
            <fieldset
              v-for="question in questionsOf(item)"
              :key="question.questionId"
              :disabled="item.status !== 'pending'"
            >
              <legend>{{ question.header || question.question }}</legend>
              <small v-if="question.header">{{ question.question }}</small>
              <p class="options-hint">
                {{ question.multiSelect ? '可多选' : '单选 · 再次点击可取消' }}
              </p>
              <div class="options">
                <div v-for="option in question.options" :key="option.label" class="option-row">
                  <button
                    type="button"
                    :class="{
                      selected: draftOf(item, question.questionId).selectedLabels.includes(
                        option.label,
                      ),
                    }"
                    @click="
                      toggleOption(item, question.questionId, option.label, question.multiSelect)
                    "
                  >
                    <b>{{ option.label }}</b
                    ><span v-if="option.description">{{ option.description }}</span>
                  </button>
                  <input
                    v-if="draftOf(item, question.questionId).selectedLabels.includes(option.label)"
                    class="option-note-input"
                    :value="draftOf(item, question.questionId).optionNotes[option.label] ?? ''"
                    placeholder="为这个选项补充描述（可选）"
                    @input="onOptionNoteInput(item, question.questionId, option.label, $event)"
                  />
                </div>
              </div>
              <input
                :value="draftOf(item, question.questionId).freeText"
                placeholder="其他补充（可选）"
                @input="onOtherInput(item, question.questionId, $event)"
              />
              <p
                v-if="interactions.questionErrorsById[item.interactionId]?.[question.questionId]"
                class="object-error"
                role="alert"
              >
                {{
                  interactions.questionErrorsById[item.interactionId]?.[question.questionId]
                    ?.message
                }}
              </p>
            </fieldset>
          </div>

          <p v-if="interactions.errorsById[item.interactionId]" class="object-error" role="alert">
            {{ interactions.errorsById[item.interactionId]?.message }}
          </p>

          <footer>
            <button
              type="button"
              class="locate"
              @click="
                emit('tree', item.rootChatId, item.chatId, item.interactionId, item.anchorNodeId)
              "
            >
              在节点树中查看
            </button>
            <template v-if="section === 'pending' && item.kind === 'approval'">
              <button
                type="button"
                class="reject"
                :disabled="item.status === 'resolving'"
                @click="decide(item, 'reject')"
              >
                拒绝
              </button>
              <button
                type="button"
                class="accept"
                :disabled="item.status === 'resolving'"
                @click="decide(item, 'accept')"
              >
                {{ item.status === 'blocked' ? '重试并接受' : '接受' }}
              </button>
            </template>
            <button
              v-else-if="section === 'pending' && item.kind === 'question_batch'"
              type="button"
              class="accept"
              :disabled="item.status !== 'pending'"
              @click="answer(item)"
            >
              提交回答
            </button>
          </footer>
        </article>
      </section>
      <p v-if="scoped.length === 0" class="empty">
        {{
          interactions.loading
            ? '正在加载…'
            : section === 'pending'
              ? '没有待处理交互'
              : '暂无最近活动'
        }}
      </p>
    </div>
  </section>
</template>

<style scoped lang="less">
@import '@/styles/scrollbar.less';
.interaction-inbox {
  height: 100%;
  min-height: 280px;
  padding: 12px 14px 16px;
  overflow: hidden;
  color: var(--ink);
  font-size: 13px;
}

// native 整窗模式：铺满 WindowFrame body、无二次内外边距；toolbar 固定、列表区 flex:1 内部滚动
// （浮动窗保持 padding + max-height 内滚现状，互不干扰）
.is-native.interaction-inbox {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 0;
}
.is-native .inbox-toolbar {
  flex: none;
  margin-bottom: 10px;
  padding: 0;
}
.is-native .inbox-list {
  flex: 1;
  min-height: 0;
  max-height: none;
  gap: 0;
  .inner-scrollbar();
}
.is-native .inbox-group + .inbox-group {
  margin-top: 14px;
}

// 分组导航：每会话一个 chip（accent 描边 + 计数徽标），点击滚动定位
.is-native .inbox-nav {
  flex: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 0 8px;
  overflow-x: auto;
  .inner-scrollbar(14%, 28%, 3px);
}
.is-native .nav-chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 10%, var(--surface));
  color: color-mix(in srgb, var(--ink) 78%, transparent);
  font-size: 12px;
  cursor: pointer;

  &:hover {
    background: color-mix(in srgb, var(--accent) 18%, var(--surface));
    color: var(--ink);
  }
}
.is-native .nav-chip b {
  min-width: 15px;
  padding: 0 4px;
  border-radius: 999px;
  background: #d88a26;
  color: #fff;
  font-size: 11px;
  line-height: 15px;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
// 分组头：会话名 + 计数，hover 提亮提示可点击定位
.is-native .group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 2px 2px 0;
  font-size: 12px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
  cursor: pointer;

  &:hover {
    color: color-mix(in srgb, var(--accent) 85%, var(--ink));
  }
}
.is-native .group-count {
  min-width: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: color-mix(in srgb, var(--ink) 58%, transparent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 16px;
  text-align: center;
}
.inbox-toolbar,
.segmented,
article header,
article footer {
  display: flex;
  align-items: center;
  gap: 7px;
}
.inbox-toolbar {
  justify-content: space-between;
  margin-bottom: 10px;
}
.segmented {
  padding: 2px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}
.segmented button,
.refresh {
  border: 0;
  border-radius: 7px;
  padding: 5px 9px;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  font-size: 12px;
  font-weight: 400;
  cursor: pointer;
}
.segmented button.active {
  background: var(--surface);
  color: var(--ink);
  box-shadow: 0 1px 4px color-mix(in srgb, var(--ink) 10%, transparent);
}
.inbox-list {
  display: flex;
  flex-direction: column;
  gap: 9px;
  max-height: min(62vh, 580px);
  overflow: auto;
}
.inbox-group {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
.interaction-card {
  padding: 11px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 12px;
  background: var(--surface);
}
.interaction-card.is-blocked {
  border-color: #e59a35;
}
article header {
  align-items: baseline;
}
article header strong {
  flex: 1;
  font-size: 14px;
  font-weight: 400;
}
article header small {
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  font-size: 12px;
}
article header small .countdown {
  color: #1a7f52;
}
article header small .countdown.is-expired {
  color: #c02e47;
}
// kind 标签双色高对比（需确认=金 / 需回答=紫）：实色底 + 白字，深/浅主题下对比度恒定，
// native 与浮动窗全局统一（杜绝 color-mix 混主题色在深色下底色文字同色系看不清）
.kind {
  padding: 3px 7px;
  border-radius: 999px;
  background: var(--accent);
  color: #fff;
  font-size: 12px;
  font-weight: 400;
}
.kind.is-approval {
  background: #d88a26;
}
.kind.is-question {
  background: #7c3aed;
}
.arguments {
  margin: 10px 0;
  padding: 9px;
  border-radius: 8px;
  background: var(--surface-soft);
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--ink) 88%, transparent);
}
fieldset {
  margin: 10px 0;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 9px;
}
legend {
  padding: 0 4px;
  font-size: 13px;
  font-weight: 400;
}
fieldset > small {
  display: block;
  margin-bottom: 7px;
  font-size: 12px;
  opacity: 0.88;
}
.options-hint {
  margin: 0 0 6px;
  font-size: 11px;
  color: color-mix(in srgb, var(--ink) 52%, transparent);
}
.options {
  display: grid;
  gap: 5px;
}
.option-row {
  display: grid;
  gap: 5px;
}
.options button {
  display: grid;
  gap: 2px;
  padding: 7px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 8px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.options button b {
  font-weight: 400;
}
.options button.selected {
  border-color: #c98224;
  background: color-mix(in srgb, var(--accent) 20%, var(--surface));
}
.options span {
  font-size: 12px;
  opacity: 0.72;
}
input {
  box-sizing: border-box;
  width: 100%;
  margin-top: 6px;
  padding: 7px;
  border: 1px solid color-mix(in srgb, var(--ink) 13%, transparent);
  border-radius: 7px;
  background: var(--surface);
  color: var(--ink);
  font-size: 13px;
}
.option-note-input {
  margin-top: 0;
}
article footer {
  justify-content: flex-end;
  margin-top: 9px;
}
article footer button {
  padding: 6px 11px;
  border: 0;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
}
.locate {
  margin-right: auto;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
}
.reject {
  background: color-mix(in srgb, #e35a49 14%, var(--surface));
  color: #b74438;
}
.accept {
  background: #d88a26;
  color: white;
}
.error {
  padding: 7px;
  border-radius: 8px;
  background: color-mix(in srgb, #e35a49 13%, var(--surface));
  color: #b74438;
  font-size: 12px;
}
.object-error {
  margin: 6px 0 0;
  color: var(--el-color-danger);
  font-size: 12px;
}
.empty {
  margin: 48px 0;
  text-align: center;
  opacity: 0.55;
  font-size: 13px;
}
</style>
