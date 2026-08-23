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
import { useInteractionsStore } from '@/stores'
import type { InteractionRecord } from '@/services/agentApi'
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
  Record<string, Record<string, { selectedLabels: string[]; freeText: string }>>
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
  return (group[questionId] ??= { selectedLabels: [], freeText: '' })
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
    }
  } else if (draft.selectedLabels.includes(label)) {
    draft.selectedLabels = draft.selectedLabels.filter((value) => value !== label)
  } else draft.selectedLabels.push(label)
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

              <!-- 工具能力解释（后端注入 sense 定义 description；config_manage 等）。 -->
              <p v-if="senseDescriptionOf(activeItem)" class="sense-desc">
                {{ senseDescriptionOf(activeItem) }}
              </p>

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
                  <legend>{{ question.header || question.question }}</legend>
                  <small v-if="question.header">{{ question.question }}</small>
                  <p class="options-hint">
                    {{ question.multiSelect ? '可多选' : '单选 · 再次点击可取消' }}
                  </p>
                  <div class="options">
                    <button
                      v-for="option in question.options"
                      :key="option.label"
                      type="button"
                      :class="{
                        selected: draftOf(activeItem, question.questionId).selectedLabels.includes(
                          option.label,
                        ),
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
                  </div>
                  <input
                    :value="draftOf(activeItem, question.questionId).freeText"
                    placeholder="其他补充（可选）"
                    @input="onOtherInput(activeItem, question.questionId, $event)"
                  />
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

<style scoped lang="less">
.pending-panel {
  position: absolute;
  z-index: var(--nx-z-drawer);
  top: 44px;
  right: 52px; // 位于右侧 rail 左侧，避免盖住 rail 按钮
  width: 600px; // 左右分栏后加宽：左栏导航 + 右栏详情一屏容纳，降低滚动依赖
  max-width: calc(100% - 120px);
  color: var(--nx-text);
  font-size: 13px;
  pointer-events: auto;
}
// 入口行：标题 toggle + 范围切换 + 刷新同一行。
.pending-panel-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid color-mix(in srgb, var(--nx-text) 14%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, var(--nx-bg) 86%, var(--nx-text) 8%);
  backdrop-filter: blur(9px) saturate(115%);
  color: inherit;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.22);
  transition:
    border-color 120ms ease,
    box-shadow 120ms ease;
  &:hover {
    border-color: color-mix(in srgb, var(--nx-green) 34%, transparent);
  }
}
.pending-panel.has-tasks .pending-panel-head {
  border-color: color-mix(in srgb, var(--nx-green) 42%, transparent);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--nx-green) 22%, transparent),
    0 4px 16px rgba(0, 0, 0, 0.28);
}
.pending-panel-toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  min-width: 0;
  border: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 13px;
}
.pending-panel-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  strong {
    font-size: 13px;
    font-weight: 400;
    letter-spacing: 0.02em;
  }
}
.pending-panel-glyph {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--nx-green) 26%, transparent);
  color: var(--nx-green);
  font-size: 12px;
  font-weight: 400;
  line-height: 1;
}
.pending-panel-count {
  min-width: 20px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--nx-green);
  color: var(--nx-bg);
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: center;
}
.pending-panel-toggle-icon {
  color: color-mix(in srgb, var(--nx-text) 64%, transparent);
  font-size: 12px;
}
.segmented {
  display: inline-flex;
  flex-shrink: 0;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: color-mix(in srgb, var(--nx-text) 8%, transparent);
}
.segmented button,
.refresh {
  border: 0;
  border-radius: 7px;
  padding: 5px 11px;
  background: transparent;
  color: color-mix(in srgb, var(--nx-text) 66%, transparent);
  font-size: 12px;
  font-weight: 400;
  cursor: pointer;
  &:hover:not(:disabled) {
    color: var(--nx-text);
  }
  &.active {
    background: color-mix(in srgb, var(--nx-bg) 92%, var(--nx-text) 8%);
    color: var(--nx-text);
    box-shadow: 0 1px 4px color-mix(in srgb, var(--nx-text) 12%, transparent);
  }
  &:disabled {
    opacity: 0.4;
    cursor: default;
  }
}
.refresh {
  flex-shrink: 0;
}

.pending-panel-body {
  margin-top: 6px;
  padding: 10px;
  border: 1px solid color-mix(in srgb, var(--nx-text) 14%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--nx-bg) 94%, var(--nx-text) 6%);
  backdrop-filter: blur(12px) saturate(115%);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.3);
}
.pending-panel-body-enter-active,
.pending-panel-body-leave-active {
  transition:
    opacity 140ms ease,
    transform 140ms ease;
}
.pending-panel-body-enter-from,
.pending-panel-body-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.pending-panel-error {
  margin: 0 0 8px;
  padding: 8px;
  border-radius: 8px;
  background: color-mix(in srgb, #e35a49 13%, var(--nx-bg));
  color: #ff8d7e;
  font-size: 12px;
}

// 左右两栏：左栏任务详情 + 右栏任务导航/操作。
.panel-main {
  display: flex;
  align-items: stretch;
  gap: 10px;
  min-height: 0;
}

// ── 右栏：任务导航（顺序排列、分页 ▲/▼、无滚动条）+ 底部操作按钮同列 ──
.side-col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 176px;
  flex-shrink: 0;
  align-self: stretch;
}
.task-nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.page-nav {
  border: 1px solid color-mix(in srgb, var(--nx-text) 14%, transparent);
  border-radius: 8px;
  padding: 3px 0;
  background: transparent;
  color: color-mix(in srgb, var(--nx-text) 62%, transparent);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  &:hover:not(:disabled) {
    color: var(--nx-text);
    border-color: color-mix(in srgb, var(--nx-green) 40%, transparent);
  }
  &:disabled {
    opacity: 0.35;
    cursor: default;
  }
}
.task-nav-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.task-nav-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  padding: 7px 8px;
  border: 1px solid color-mix(in srgb, var(--nx-text) 13%, transparent);
  border-radius: 9px;
  background: color-mix(in srgb, var(--nx-bg) 90%, var(--nx-text) 6%);
  color: var(--nx-text);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  transition:
    border-color 120ms ease,
    background 120ms ease;
  &:hover {
    background: color-mix(in srgb, var(--nx-text) 7%, transparent);
  }
  &.is-active {
    border-color: color-mix(in srgb, var(--nx-green) 66%, transparent);
    background: color-mix(in srgb, var(--nx-green) 16%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--nx-green) 30%, transparent);
  }
  &.is-focused:not(.is-active) {
    border-color: color-mix(in srgb, var(--nx-green) 55%, transparent);
  }
  .nav-kind {
    flex-shrink: 0;
    padding: 2px 6px;
    border-radius: 999px;
    font-size: 11px;
    line-height: 1.4;
    &.is-approval {
      background: color-mix(in srgb, #f6b73c 22%, transparent);
      color: #f6b73c;
    }
    &.is-question {
      background: color-mix(in srgb, #9d6bff 20%, transparent);
      color: #b794ff;
    }
  }
  .nav-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
      font-weight: 400;
    }
    .nav-countdown {
      color: var(--nx-green);
      font-size: 11px;
      &.is-expired {
        color: var(--nx-red);
      }
    }
  }
}
.task-nav-meta {
  text-align: center;
  color: color-mix(in srgb, var(--nx-text) 48%, transparent);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

// ── 左栏：任务详情（全部展开不滚动） ──
.task-detail {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 2px;
}
.detail-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  .locate {
    border: 0;
    padding: 0;
    background: transparent;
    color: color-mix(in srgb, var(--nx-text) 72%, transparent);
    font-size: 12px;
    cursor: pointer;
    &:hover {
      color: var(--nx-text);
      text-decoration: underline;
    }
  }
  .detail-status {
    color: color-mix(in srgb, var(--nx-text) 62%, transparent);
    font-size: 12px;
  }
}

// 工具能力解释（config_manage 等）：主题色左条 + 正常排版。
.sense-desc {
  margin: 0 0 10px;
  padding: 9px 11px;
  border-left: 2px solid color-mix(in srgb, var(--nx-green) 58%, transparent);
  border-radius: 0 7px 7px 0;
  background: color-mix(in srgb, var(--nx-code-bg) 40%, transparent);
  color: var(--nx-text);
  font-size: 13px;
  line-height: 1.65;
  white-space: pre-line;
}

// ParsedArgs（浅色基组件）在深色 CRT 面板内需反相：调用共享主题 override 命名空间。
.task-detail :deep(.args) {
  margin: 6px 0;
  color: var(--nx-text);
}

.questions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
fieldset {
  margin: 0;
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--nx-text) 14%, transparent);
  border-radius: 9px;
  &:disabled {
    opacity: 0.6;
  }
  legend {
    padding: 0 4px;
    font-size: 13px;
    font-weight: 400;
    color: var(--nx-text);
  }
  > small {
    display: block;
    margin-bottom: 6px;
    font-size: 12px;
    opacity: 0.88;
  }
}
// 单选/多选提示行：明确告知「单选可再次点击取消」（此前用户误以为选项与补充会叠加）。
.options-hint {
  margin: 0 0 6px;
  font-size: 11px;
  color: color-mix(in srgb, var(--nx-text) 52%, transparent);
}
.options {
  display: grid;
  gap: 5px;
}
.options button {
  display: grid;
  gap: 2px;
  padding: 7px;
  border: 1px solid color-mix(in srgb, var(--nx-text) 16%, transparent);
  border-radius: 8px;
  background: transparent;
  color: var(--nx-text);
  text-align: left;
  cursor: pointer;
  &:hover {
    background: color-mix(in srgb, var(--nx-text) 7%, transparent);
  }
  &.selected {
    border-color: color-mix(in srgb, var(--nx-green) 64%, transparent);
    background: color-mix(in srgb, var(--nx-green) 20%, transparent);
  }
  b {
    font-size: 13px;
    font-weight: 400;
  }
  span {
    font-size: 12px;
    opacity: 0.72;
  }
}
input {
  box-sizing: border-box;
  width: 100%;
  margin-top: 6px;
  padding: 7px;
  border: 1px solid color-mix(in srgb, var(--nx-text) 16%, transparent);
  border-radius: 7px;
  background: color-mix(in srgb, var(--nx-bg) 92%, var(--nx-text) 8%);
  color: var(--nx-text);
  font-size: 13px;
  &::placeholder {
    color: color-mix(in srgb, var(--nx-text) 48%, transparent);
  }
}

// 右列底部操作区（margin-top:auto 贴列底，与任务按钮同列）。
.side-actions {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--nx-text) 12%, transparent);
  button {
    width: 100%;
    padding: 6px 11px;
    border: 0;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 400;
    cursor: pointer;
    &:disabled {
      opacity: 0.5;
      cursor: default;
    }
  }
  .reject {
    background: color-mix(in srgb, #e35a49 16%, transparent);
    color: #ff8d7e;
  }
  .accept {
    background: var(--nx-green);
    color: var(--nx-bg);
    font-weight: 400;
  }
}

.pending-panel-empty {
  margin: 24px 0;
  text-align: center;
  opacity: 0.55;
  font-size: 13px;
}
</style>
