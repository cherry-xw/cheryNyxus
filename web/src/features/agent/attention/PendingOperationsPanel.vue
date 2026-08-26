<script setup lang="ts">
/**
 * PendingOperationsPanel —— 工作台常驻「待操作任务」面板（统一全局消息式入口）。
 *
 * 收敛全部待操作入口（节点弹窗/纸牌的提问审批卡、右侧 ! 抽屉、composer 回答提问）：
 * - 数据源：interactions store（服务端 interaction 权威记录），含审批 + 提问批次。
 * - 范围：默认「当前树」（rootChatId 命中），可切「全部」工作区。
 * - 形态（2026-08-23 左右分栏重构）：入口行（标题+范围切换+刷新）＋ 左右两栏：
 *   左栏当前任务详情全部展开不滚动（顶部定位链接 + 单选提示），右栏任务小按钮顺序排列
 *   （分页 ▲/▼ 翻页，不用滚动条）+ 底部操作按钮同列（接受/拒绝/提交回答），一屏内完成全部交互。
 * - 渲染：审批用 ParsedArgs 结构化参数 + 接受/拒绝；提问直接内嵌选项/其他补充表单 + 提交回答。
 * - 关联：每条「在节点树中查看」→ 父级定位并高亮对应节点（面板 ↔ 节点双向）。
 * Pet 小窗口模式保持自身气泡交互，不受本面板影响。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useInteractionsStore } from '@/application/public'
import type { InteractionRecord } from '@/application/backend/public'
import ParsedArgs from '@/features/agent/cards/ParsedArgs.vue'
import { toSenseNameZh } from '@/utils/senseName'
import { parseArgs } from '@/utils/parseArgs'

const props = defineProps<{
  /** 当前工作台窗口的根会话 id（「当前树」范围判定；缺省则默认全部）。 */
  rootChatId?: string
  /** 树侧激活的带待处理交互节点 → 面板聚焦匹配条目。 */
  focusedInteraction?: PendingInteractionFocus
}>()
const emit = defineEmits<{
  /** 在节点树中查看：父级据 item.rootChatId/anchorNodeId 定位并高亮节点。 */
  locate: [item: InteractionRecord]
}>()

/** 面板 ↔ 节点树双向关联的聚焦载荷：匹配 interactions 记录用 interactionId（=审批 id / 批次 id）。 */
export interface PendingInteractionFocus {
  chatId: string
  /** 审批（approvalId）或提问批次（batchId）；缺省则按 anchorNodeId 匹配。 */
  interactionId?: string
  anchorNodeId?: string
}

const interactions = useInteractionsStore()
const scope = ref<'tree' | 'all'>('tree')
const expanded = ref(false)
/** 当前选中（active）的交互 id：左栏按钮点击切换；一次只选一个。 */
const activeId = ref<string>()
const submitError = ref('')
/** 审批倒计时驱动：now 每 250ms 刷新，重算各卡剩余秒。仅存在 deadlineAt 的审批项时才有意义。 */
const now = ref(Date.now())
let countdownTimer: ReturnType<typeof setInterval> | undefined
/** 各交互的作答草稿（interactionId → questionId → 草稿），跨刷新保留。 */
const drafts = reactive<
  Record<
    string,
    Record<
      string,
      { selectedLabels: string[]; optionNotes: Record<string, string>; freeText: string }
    >
  >
>({})

interface PanelQuestion {
  questionId: string
  question: string
  header?: string
  options: Array<{ label: string; description?: string }>
  multiSelect: boolean
}

const scopedPending = computed(() => {
  const list = interactions.pending
  if (scope.value === 'all' || !props.rootChatId) return list
  return list.filter((item) => item.rootChatId === props.rootChatId)
})

/** 与树侧聚焦节点匹配的当前条目（按 interactionId，缺省回退 anchorNodeId）。 */
const focusedItem = computed(() => {
  const focus = props.focusedInteraction
  if (!focus) return undefined
  return scopedPending.value.find((item) => {
    if (focus.interactionId) return item.interactionId === focus.interactionId
    return focus.anchorNodeId
      ? item.anchorNodeId === focus.anchorNodeId
      : item.chatId === focus.chatId
  })
})

/** 树侧聚焦待处理节点 → 面板展开、选中并定位（翻页由 syncPageToActive 承接）。 */
watch(focusedItem, (item) => {
  if (!item) return
  expanded.value = true
  activeId.value = item.interactionId
})

// ── 左栏分页：每页任务按钮数；任务过多时 ▲/▼ 翻页（不用滚动条） ──
const PAGE_SIZE = 8
const page = ref(1)
const lastPage = computed(() => Math.max(1, Math.ceil(scopedPending.value.length / PAGE_SIZE)))
const pageItems = computed(() =>
  scopedPending.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE),
)
/** 页码同步：active/聚焦任务不在当前页时自动翻页定位；列表缩减时夹住越界页。 */
function syncPageToActive(): void {
  const id = activeId.value ?? focusedItem.value?.interactionId
  const list = scopedPending.value
  const index = id ? list.findIndex((item) => item.interactionId === id) : -1
  if (index < 0) {
    if (page.value > lastPage.value) page.value = lastPage.value
    return
  }
  const targetPage = Math.floor(index / PAGE_SIZE) + 1
  if (page.value !== targetPage) page.value = targetPage
}
watch([scopedPending, activeId, focusedItem], syncPageToActive)

/** 右栏当前渲染的任务：active 项优先，缺失回退首个 pending（activeId 维护 watch 兜底）。 */
const activeItem = computed<InteractionRecord | undefined>(
  () =>
    scopedPending.value.find((item) => item.interactionId === activeId.value) ??
    scopedPending.value.find((item) => item.status === 'pending') ??
    scopedPending.value[0],
)

/** 有任务自动展开、无任务自动收起（用户手动展开/收起仍可覆盖；任务数变化时回自动态）。 */
watch(
  scopedPending,
  (list, prev) => {
    const had = (prev?.length ?? 0) > 0
    const has = list.length > 0
    if (has && !had) expanded.value = true
    if (!has && had) expanded.value = false
  },
  { immediate: true },
)

/**
 * activeId 维护（左栏互斥选中）：
 * - 首次挂载：激活首个 pending（优先树侧聚焦项）。
 * - active 项被移除（decide/answer 完成或超时）→ 自动激活下一个继续交互。
 * - 用户切范围导致 active 落空 → 同左。
 */
let activeInitialized = false
function pickNextActive(list: InteractionRecord[]): string | undefined {
  const focus = focusedItem.value
  if (focus && list.some((item) => item.interactionId === focus.interactionId)) {
    return focus.interactionId
  }
  return list.find((item) => item.status === 'pending')?.interactionId
}
watch(
  scopedPending,
  (list) => {
    if (activeId.value) {
      // active 项仍在列表 → 保留；被移除 → 自动激活下一个。
      if (!list.some((item) => item.interactionId === activeId.value)) {
        activeId.value = pickNextActive(list)
      }
      return
    }
    if (!activeInitialized) {
      activeInitialized = true
      activeId.value = pickNextActive(list)
    }
  },
  { immediate: true },
)

function toggleExpanded(): void {
  expanded.value = !expanded.value
}

/**
 * config_manage 各 action 的用户可见短描述（核心任务 + 当前操作一句，前端维护）。
 * 仅展示实际发起的 action，避免全量能力说明堆叠——「用到哪里看到哪里」。
 */
const CONFIG_MANAGE_ACTION_DESC: Record<string, string> = {
  get: '读取 .chery/config.yaml 完整脱敏配置并返回回滚点列表',
  save: '把改动后的完整配置写盘保存（写盘前自动备份旧配置）',
  rollback: '从 .chery/backups/ 恢复指定（或缺省最近）备份',
}

/** 从审批 arguments（JSON 字符串或对象，复用 parseArgs 契约）安全提取 action 字段。 */
function argsActionOf(item: InteractionRecord): string | undefined {
  const { parsed } = parseArgs(payload(item).arguments)
  const action = parsed?.entries.find((entry) => entry.key === 'action')?.value
  return typeof action === 'string' && action.trim() ? action : undefined
}

/**
 * config_manage 审批说明：按实际发起的 action 裁剪为「核心任务 + 当前操作」一句。
 * action 缺失/未知时返回 undefined（不展示说明，宁缺毋滥）。
 */
function configManageDescriptionOf(item: InteractionRecord): string | undefined {
  const action = argsActionOf(item)
  const actionDesc = action ? CONFIG_MANAGE_ACTION_DESC[action] : undefined
  if (!actionDesc) return undefined
  return `核心任务：管理 .chery/config.yaml 配置。\n当前操作（${action}）：${actionDesc}`
}

/** 工具能力解释（后端注入 sense 定义 description；config_manage 按 action 裁剪）。缺失时不展示。 */
function senseDescriptionOf(item: InteractionRecord): string | undefined {
  if (String(payload(item).senseName ?? '') === 'config_manage') {
    return configManageDescriptionOf(item)
  }
  const desc = payload(item).senseDescription
  return typeof desc === 'string' && desc.trim() ? desc.trim() : undefined
}

function payload(item: InteractionRecord): Record<string, unknown> {
  return item.payload ?? {}
}
function questionsOf(item: InteractionRecord): PanelQuestion[] {
  return Array.isArray(payload(item).questions) ? (payload(item).questions as PanelQuestion[]) : []
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
    if (draft.selectedLabels.includes(label)) draft.selectedLabels = []
    else {
      draft.selectedLabels = [label]
      draft.freeText = ''
      // 单选切选项：丢弃其他选项的补充描述
      draft.optionNotes = { ...(draft.optionNotes[label] ? { [label]: draft.optionNotes[label] } : {}) }
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
/** 「其他补充」输入：单选模式下输入即清空已选选项（与选项互斥，单选二选一）。 */
function onOtherInput(item: InteractionRecord, questionId: string, event: Event): void {
  const draft = draftOf(item, questionId)
  draft.freeText = (event.target as HTMLInputElement).value
  const question = questionsOf(item).find((q) => q.questionId === questionId)
  if (question && !question.multiSelect && draft.freeText.trim()) draft.selectedLabels = []
}
function titleOf(item: InteractionRecord): string {
  if (item.kind === 'approval') {
    return `确认 ${toSenseNameZh(String(payload(item).senseName ?? ''))}`
  }
  const questions = questionsOf(item)
  return questions[0]?.header || questions[0]?.question || '回答 Agent 提问'
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

// ── 左栏详情分块折叠：能力解释默认折叠；每个问题块独立折叠（默认展开） ──
const senseDescCollapsed = ref(true)
/** 按 questionId 记录各问题块的折叠态（缺省=展开）；切换 active 任务后新块自然回落到展开。 */
const collapsedQuestions = reactive<Record<string, boolean>>({})
function toggleQuestion(questionId: string): void {
  collapsedQuestions[questionId] = !collapsedQuestions[questionId]
}
function isQuestionCollapsed(questionId: string): boolean {
  return collapsedQuestions[questionId] === true
}

/**
 * 审批倒计时：approval 且带 deadlineAt 时返回剩余毫秒与是否超时；否则 total=0（不显示）。
 * 与 ApprovalCard 语义一致（deadlineAt = createdAt + waitTime，后端写入）。
 */
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
async function decide(item: InteractionRecord, action: 'accept' | 'reject'): Promise<void> {
  submitError.value = ''
  try {
    await interactions.decide(item, action)
  } catch (cause) {
    submitError.value = cause instanceof Error ? cause.message : '审批失败'
  }
}
/** 提交可点判定：单选恰好 1 项或有「其他补充」输入；多选 ≥1。无选择/输入时提交按钮禁用（灰）。 */
function canSubmitOf(item: InteractionRecord): boolean {
  const qs = questionsOf(item)
  if (!qs.length) return false
  return qs.every((question) => {
    const draft = draftOf(item, question.questionId)
    if (draft.freeText.trim()) return true
    return question.multiSelect
      ? draft.selectedLabels.length > 0
      : draft.selectedLabels.length === 1
  })
}

async function answer(item: InteractionRecord): Promise<void> {
  submitError.value = ''
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
  if (answers.some((answer) => answer.selectedLabels.length === 0 && !answer.freeText)) {
    submitError.value = '请完成全部问题后提交'
    return
  }
  if (
    answers.some(
      (answer) => !answer.multiSelect && answer.selectedLabels.length > 0 && answer.freeText,
    )
  ) {
    submitError.value = '单选题请在选项与「其他补充」中二选一'
    return
  }
  // 丢弃 multiSelect 哨兵字段后提交（与 WorkspaceSessionBrowser 语义一致，显式构造避免解构未用变量）。
  const submit = answers.map((answer) => ({
    questionId: answer.questionId,
    selectedLabels: answer.selectedLabels,
    ...(answer.optionNotes !== undefined ? { optionNotes: answer.optionNotes } : {}),
    ...(answer.freeText !== undefined ? { freeText: answer.freeText } : {}),
  }))
  try {
    await interactions.answer(item, submit)
  } catch (cause) {
    submitError.value = cause instanceof Error ? cause.message : '回答失败'
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
  <section
    class="pending-panel"
    :class="{ 'is-expanded': expanded, 'has-tasks': scopedPending.length > 0 }"
    aria-label="待操作任务"
  >
    <!-- 入口行：标题（点击收起/展开）+ 范围切换 + 刷新，同一行。 -->
    <div class="pending-panel-head">
      <button
        type="button"
        class="pending-panel-toggle"
        :aria-expanded="expanded"
        @click="toggleExpanded"
      >
        <span class="pending-panel-title">
          <span class="pending-panel-glyph" aria-hidden="true">!</span>
          <strong>待操作</strong>
          <b v-if="scopedPending.length" class="pending-panel-count">{{ scopedPending.length }}</b>
        </span>
        <span class="pending-panel-toggle-icon" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      </button>
      <div class="segmented" role="group" aria-label="待操作范围">
        <button
          type="button"
          :class="{ active: scope === 'tree' }"
          :disabled="!rootChatId"
          :aria-pressed="scope === 'tree'"
          @click="scope = 'tree'"
        >
          当前树
        </button>
        <button
          type="button"
          :class="{ active: scope === 'all' }"
          :aria-pressed="scope === 'all'"
          @click="scope = 'all'"
        >
          全部
        </button>
      </div>
      <button
        type="button"
        class="refresh"
        :disabled="interactions.loading"
        title="刷新待操作"
        aria-label="刷新待操作"
        @click="interactions.refresh()"
      >
        ↻
      </button>
    </div>

    <Transition name="pending-panel-body">
      <div v-if="expanded" class="pending-panel-body">
        <p v-if="submitError || interactions.error" class="pending-panel-error">
          {{ submitError || interactions.error }}
        </p>

        <div class="panel-main">
          <!-- 左栏：当前任务详情（全部展开不滚动 + 顶部定位）。 -->
          <div class="task-detail">
            <template v-if="activeItem">
              <div class="detail-top">
                <button type="button" class="locate" @click="emit('locate', activeItem)">
                  在节点树中查看
                </button>
                <span class="detail-status">{{ statusOf(activeItem) }}</span>
              </div>

              <!-- 工具能力解释（后端注入 sense 定义 description；config_manage 等）。默认折叠，点击标题展开。 -->
              <div v-if="senseDescriptionOf(activeItem)" class="detail-block">
                <button
                  type="button"
                  class="detail-block-toggle"
                  :aria-expanded="!senseDescCollapsed"
                  @click="senseDescCollapsed = !senseDescCollapsed"
                >
                  <span class="detail-block-glyph" aria-hidden="true">{{
                    senseDescCollapsed ? '▸' : '▾'
                  }}</span>
                  工具能力解释
                </button>
                <p v-show="!senseDescCollapsed" class="sense-desc">
                  {{ senseDescriptionOf(activeItem) }}
                </p>
              </div>

              <ParsedArgs
                v-if="activeItem.kind === 'approval'"
                :args="payload(activeItem).arguments"
              />
              <div v-else class="questions">
                <fieldset
                  v-for="question in questionsOf(activeItem)"
                  :key="question.questionId"
                  :disabled="activeItem.status !== 'pending'"
                >
                  <legend
                    class="question-toggle"
                    :aria-expanded="!isQuestionCollapsed(question.questionId)"
                    @click="toggleQuestion(question.questionId)"
                  >
                    <span class="detail-block-glyph" aria-hidden="true">{{
                      isQuestionCollapsed(question.questionId) ? '▸' : '▾'
                    }}</span>
                    {{ question.header || question.question }}
                  </legend>
                  <template v-if="!isQuestionCollapsed(question.questionId)">
                    <small v-if="question.header">{{ question.question }}</small>
                    <p class="options-hint">
                      {{ question.multiSelect ? '可多选' : '单选 · 再次点击可取消' }}
                    </p>
                    <div class="options">
                      <div
                        v-for="option in question.options"
                        :key="option.label"
                        class="option-row"
                      >
                        <button
                          type="button"
                          :class="{
                            selected: draftOf(
                              activeItem,
                              question.questionId,
                            ).selectedLabels.includes(option.label),
                          }"
                          @click="
                            toggleOption(
                              activeItem,
                              question.questionId,
                              option.label,
                              question.multiSelect,
                            )
                          "
                        >
                          <b>{{ option.label }}</b
                          ><span v-if="option.description">{{ option.description }}</span>
                        </button>
                        <input
                          v-if="
                            draftOf(activeItem, question.questionId).selectedLabels.includes(
                              option.label,
                            )
                          "
                          class="option-note-input"
                          :value="
                            draftOf(activeItem, question.questionId).optionNotes[option.label] ??
                            ''
                          "
                          placeholder="为这个选项补充描述（可选）"
                          @input="
                            onOptionNoteInput(
                              activeItem,
                              question.questionId,
                              option.label,
                              $event,
                            )
                          "
                        />
                      </div>
                    </div>
                    <input
                      :value="draftOf(activeItem, question.questionId).freeText"
                      placeholder="其他补充（可选）"
                      @input="onOtherInput(activeItem, question.questionId, $event)"
                    />
                  </template>
                </fieldset>
              </div>
            </template>

            <p v-else class="pending-panel-empty">
              {{ interactions.loading ? '正在加载…' : '没有待操作任务' }}
            </p>
          </div>

          <!-- 右栏：任务导航（▲/▼ 分页）+ 操作按钮同一列。 -->
          <div class="side-col">
            <nav class="task-nav" aria-label="待操作任务列表">
              <button
                type="button"
                class="page-nav"
                :disabled="page <= 1 || !scopedPending.length"
                aria-label="上一页"
                @click="page -= 1"
              >
                ▲
              </button>
              <div class="task-nav-list">
                <button
                  v-for="item in pageItems"
                  :key="item.interactionId"
                  type="button"
                  class="task-nav-btn"
                  :class="[
                    `is-${item.kind}`,
                    {
                      'is-active': item.interactionId === activeItem?.interactionId,
                      'is-focused': item.interactionId === focusedItem?.interactionId,
                    },
                  ]"
                  :aria-current="
                    item.interactionId === activeItem?.interactionId ? 'true' : undefined
                  "
                  @click="activeId = item.interactionId"
                >
                  <span class="nav-kind" :class="`is-${item.kind}`">{{
                    item.kind === 'approval' ? '确认' : '回答'
                  }}</span>
                  <span class="nav-text">
                    <strong>{{ titleOf(item) }}</strong>
                    <small
                      v-if="countdownOf(item).total"
                      class="nav-countdown"
                      :class="{ 'is-expired': countdownOf(item).expired }"
                    >
                      {{
                        countdownOf(item).expired
                          ? '已超时'
                          : `剩余 ${Math.ceil(countdownOf(item).remaining / 1000)}s`
                      }}
                    </small>
                  </span>
                </button>
              </div>
              <button
                type="button"
                class="page-nav"
                :disabled="page >= lastPage || !scopedPending.length"
                aria-label="下一页"
                @click="page += 1"
              >
                ▼
              </button>
              <span v-if="scopedPending.length" class="task-nav-meta"
                >{{ page }}/{{ lastPage }}</span
              >
            </nav>

            <footer v-if="activeItem" class="side-actions">
              <template v-if="activeItem.kind === 'approval'">
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
                  {{ activeItem.status === 'blocked' ? '重试并接受' : '接受' }}
                </button>
              </template>
              <button
                v-else
                type="button"
                class="accept"
                :disabled="activeItem.status !== 'pending' || !canSubmitOf(activeItem)"
                @click="answer(activeItem)"
              >
                提交回答
              </button>
            </footer>
          </div>
        </div>
      </div>
    </Transition>
  </section>
</template>

<style scoped lang="less" src="./PendingOperationsPanel.styles.less"></style>
