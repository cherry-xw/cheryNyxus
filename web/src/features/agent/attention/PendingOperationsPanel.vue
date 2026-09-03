<script setup lang="ts">
/**
 * PendingOperationsPanel —— 工作台常驻「待操作任务」面板（Interrupt Queue 聚焦流水线）。
 *
 * 2026-09-02 重构：放弃「右栏任务列表 + 左栏详情 + 内嵌问题两栏」旧结构，改为单层无嵌套
 * 聚焦流水线（范式参照 Linear triage / macOS 弹窗队列）：状态头（IRQ 徽记 + X/Y 进度 +
 * 范围切换）→ FOCUS CARD（唯一工作对象：审批全量展示 / 提问步进器一次一题、备注内嵌
 * 选项卡内）→ QUEUE 缩略带（PendingQueueStrip 取代旧 ▲/▼ 分页）。动效全经 useGsap context
 * 调度，opacityOnly 档退化为 opacity。数据/契约不变：drafts 跨刷新、canSubmitOf 前置禁用、
 * 双向定位、calibratedNow 倒计时、自动展开收起、active 移除自动激活下一个。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useInteractionsStore } from '@/application/public'
import type { InteractionRecord } from '@/application/backend/public'
import ApprovalSummary from '@/features/agent/cards/ApprovalSummary.vue'
import ParsedArgs from '@/features/agent/cards/ParsedArgs.vue'
import FileChangeDiff from '@/features/agent/cards/FileChangeDiff.vue'
import QuestionStepper from './QuestionStepper.vue'
import PendingQueueStrip, { type QueueChipItem } from './PendingQueueStrip.vue'
import { createApprovalPresentation } from '@/utils/approvalPresentation'
import { gsap } from 'gsap'
import { MOTION } from '@/utils/gsapCore'
import { useGsap } from '@/composables/useGsap'
import { useMotionTier } from '@/composables/useMotionTier'

type FlipPlugin = (typeof import('gsap/Flip'))['Flip']
let flipPluginPromise: Promise<FlipPlugin> | undefined

function loadFlipPlugin(): Promise<FlipPlugin> {
  flipPluginPromise ??= import('gsap/Flip').then(({ Flip }) => {
    gsap.registerPlugin(Flip)
    return Flip
  })
  return flipPluginPromise
}

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
const panelRoot = ref<HTMLElement | null>(null)
const focusCardEl = ref<HTMLElement | null>(null)
const optionsEl = ref<HTMLElement | null>(null)
/** 备注行 Flip 防重入哨兵：动画期间再点击只改状态不做 Flip。 */
let noteFlipBusy = false

/** 当前选中（active）的交互 id：队列 chip / 聚焦卡唯一工作对象。 */
const activeId = ref<string>()
const submitError = ref('')
/** 审批倒计时驱动：now 每 250ms 刷新（calibratedNow 含服务器钟偏移校准）。 */
const now = ref(Date.now())
let countdownTimer: ReturnType<typeof setInterval> | undefined
/** 各交互的作答草稿（interactionId → questionId → 草稿），跨刷新保留。 */
type QuestionDraft = {
  selectedLabels: string[]
  optionNotes: Record<string, string>
  freeText: string
}
const drafts = reactive<Record<string, Record<string, QuestionDraft>>>({})

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

/** 树侧聚焦待处理节点 → 面板展开、选中（队列带 scrollIntoView 承接定位）。 */
watch(focusedItem, (item) => {
  if (!item) return
  expanded.value = true
  activeId.value = item.interactionId
})

/** 当前渲染的任务：active 项优先，缺失回退首个 pending（activeId 维护 watch 兜底）。 */
const activeItem = computed<InteractionRecord | undefined>(
  () =>
    scopedPending.value.find((item) => item.interactionId === activeId.value) ??
    scopedPending.value.find((item) => item.status === 'pending') ??
    scopedPending.value[0],
)

/** 聚焦序号（头部 X/Y 进度与队列高亮）。 */
const activeIndex = computed(() => {
  const id = activeItem.value?.interactionId
  return id ? scopedPending.value.findIndex((item) => item.interactionId === id) : -1
})

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

// activeId 维护：首次挂载激活首个 pending（优先树侧聚焦项）；active 被移除或切范围落空 → 自动激活下一个。
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

// GSAP 调度：useGsap 的 setup 只在 onMounted 跑一次；事后触发的 tween 一律经 ctx.add 登记，
// 卸载 revert 全回收（禁止裸 gsap.to 逃逸 context，见 useGsap.ts 头注释）。
let gsapCtx: gsap.Context | undefined
const { spec: motionSpec } = useMotionTier()

/** 位移类动效是否可用：opacityOnly 档（低渲染质量 / reduced 偏好）只保留透明度反馈。 */
function canMove(): boolean {
  return (
    motionSpec.value.enter !== 'opacityOnly' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

useGsap(panelRoot, (ctx) => (gsapCtx = ctx))

/** 队列 chips 入场 stagger：任务数变化时触发一次（切换 scope / 新增 / 完成移除）。 */
watch(
  () => scopedPending.value.length,
  async () => {
    await nextTick()
    const chips = panelRoot.value?.querySelectorAll<HTMLElement>('.queue-chip')
    if (!chips?.length) return
    const stagger = motionSpec.value.stagger
    gsapCtx?.add(() => {
      if (stagger > 0) {
        gsap.from(chips, {
          y: 8,
          autoAlpha: 0,
          duration: MOTION.panel,
          ease: MOTION.easePanel,
          stagger,
        })
      } else {
        gsap.from(chips, { autoAlpha: 0, duration: MOTION.micro })
      }
    })
  },
  { immediate: true },
)

/** 聚焦任务切换：聚焦卡 crossfade + slide 入场（内容随响应式同步换，旧卡不做离场以免双写）。 */
watch(
  () => activeItem.value?.interactionId,
  async (id, prevId) => {
    if (!id || id === prevId) return
    await nextTick()
    const card = focusCardEl.value
    if (!card) return
    gsapCtx?.add(() => {
      if (canMove()) {
        gsap.from(card, { autoAlpha: 0, x: 14, duration: MOTION.view, ease: MOTION.easePanel })
      } else {
        gsap.from(card, { autoAlpha: 0, duration: MOTION.micro })
      }
    })
  },
)

// ── 展开收起：Flip 对根元素做布局补偿（沿用既有模式，时长换 MOTION.sweep）──
async function toggleExpanded(): Promise<void> {
  const element = panelRoot.value
  if (!element || !canMove()) {
    expanded.value = !expanded.value
    return
  }
  const Flip = await loadFlipPlugin()
  const state = Flip.getState(element)
  expanded.value = !expanded.value
  requestAnimationFrame(() => {
    gsapCtx?.add(() => {
      Flip.from(state, {
        duration: MOTION.sweep,
        ease: 'power3.inOut',
        absolute: false,
        simple: true,
      })
    })
  })
}

// ── 工具能力解释（后端注入 sense 定义 description）。缺失时不展示。 ──
function senseDescriptionOf(item: InteractionRecord): string | undefined {
  const desc = payload(item).senseDescription
  return typeof desc === 'string' && desc.trim() ? desc.trim() : undefined
}

function approvalPresentationOf(item: InteractionRecord) {
  return createApprovalPresentation(payload(item).senseName, payload(item).arguments)
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

/**
 * 选项卡点击（选择 + 备注行 Flip 一体）：Flip 在状态变更前对整个 .options 容器取 getState
 * （备注行的插入/移除会推移兄弟行），nextTick 后 Flip.from 补偿，新备注行单独淡入。
 * 不自动跳题：每个选中选项都带可选备注输入，跳转会打断备注输入——翻题一律走步进器手动。
 */
async function onOptionClick(
  item: InteractionRecord,
  question: PanelQuestion,
  label: string,
): Promise<void> {
  let state: ReturnType<FlipPlugin['getState']> | undefined
  const Flip = canMove() && !noteFlipBusy ? await loadFlipPlugin() : undefined
  if (Flip && optionsEl.value) {
    state = Flip.getState(optionsEl.value.children)
    noteFlipBusy = true
  }

  toggleOption(item, question.questionId, label, question.multiSelect)
  await nextTick()

  if (Flip && state && optionsEl.value) {
    gsapCtx?.add(() => {
      Flip.from(state, { duration: MOTION.micro, ease: MOTION.easePanel, simple: true })
      // 新插入的备注行（不在 state 里）单独淡入，避免闪现。
      const fresh = optionsEl.value?.querySelectorAll<HTMLElement>(
        '.option-card.is-selected .option-note',
      )
      fresh?.forEach((node) => gsap.from(node, { autoAlpha: 0, duration: MOTION.micro }))
    })
  }
  noteFlipBusy = false
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
      draft.optionNotes = {
        ...(draft.optionNotes[label] ? { [label]: draft.optionNotes[label] } : {}),
      }
    }
  } else if (draft.selectedLabels.includes(label)) {
    draft.selectedLabels = draft.selectedLabels.filter((value) => value !== label)
    const rest = { ...draft.optionNotes }
    delete rest[label]
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
    return approvalPresentationOf(item).title
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

// ── 提问步进：外层任务切换走队列带，提问任务在聚焦卡内切换单个问题。 ──
const senseDescCollapsed = ref(true)
const activeQuestionByInteraction = reactive<Record<string, string>>({})
function questionAnsweredOf(item: InteractionRecord, question: PanelQuestion): boolean {
  const draft = draftOf(item, question.questionId)
  if (draft.freeText.trim()) return true
  return question.multiSelect ? draft.selectedLabels.length > 0 : draft.selectedLabels.length === 1
}
function activeQuestionIdOf(item: InteractionRecord): string {
  const questions = questionsOf(item)
  const saved = activeQuestionByInteraction[item.interactionId]
  if (saved && questions.some((question) => question.questionId === saved)) return saved
  return questions[0]?.questionId ?? ''
}
const activeQuestion = computed(() => {
  const item = activeItem.value
  if (!item || item.kind !== 'question_batch') return undefined
  const id = activeQuestionIdOf(item)
  return questionsOf(item).find((question) => question.questionId === id)
})
const activeQuestionIndex = computed(() => {
  const item = activeItem.value
  if (!item) return -1
  return questionsOf(item).findIndex((q) => q.questionId === activeQuestionIdOf(item))
})
function selectQuestion(item: InteractionRecord, questionId: string): void {
  activeQuestionByInteraction[item.interactionId] = questionId
}

/** 步进器回调：按序号选中当前任务的问题（内部自守卫，模板箭头内不做联合类型收窄）。 */
function selectActiveQuestionAt(index: number): void {
  const item = activeItem.value
  if (!item) return
  const question = questionsOf(item)[index]
  if (question) selectQuestion(item, question.questionId)
}
/** 步进器上一题/下一题（越界即忽略）。 */
function stepQuestion(delta: number): void {
  selectActiveQuestionAt(activeQuestionIndex.value + delta)
}

/** 题切换方向感知 slide：下一题从右入、上一题从左入；opacityOnly 只做透明度。 */
let lastQuestionIndex = -1
watch(activeQuestionIndex, async (index) => {
  const direction = lastQuestionIndex < 0 || index >= lastQuestionIndex ? 1 : -1
  lastQuestionIndex = index
  if (index < 0) return
  await nextTick()
  const stage = focusCardEl.value?.querySelector<HTMLElement>('.question-stage')
  if (!stage) return
  gsapCtx?.add(() => {
    if (canMove()) {
      gsap.from(stage, {
        autoAlpha: 0,
        x: 16 * direction,
        duration: MOTION.view,
        ease: MOTION.easePanel,
      })
    } else {
      gsap.from(stage, { autoAlpha: 0, duration: MOTION.micro })
    }
  })
})

/** 当前任务各题的已答标记（步进器进度点；模板箭头内无法收窄 activeItem，收敛为 computed）。 */
const answeredFlagsOfActiveItem = computed<boolean[]>(() => {
  const item = activeItem.value
  if (!item) return []
  return questionsOf(item).map((question) => questionAnsweredOf(item, question))
})

function answeredQuestionCountOf(item: InteractionRecord): number {
  return questionsOf(item).filter((question) => questionAnsweredOf(item, question)).length
}

/** 队列缩略带条目：kind/标题/倒计时摘要（countdown 计算仍由 countdownOf 承担）。 */
const queueItems = computed<QueueChipItem[]>(() =>
  scopedPending.value.map((item) => ({
    interactionId: item.interactionId,
    kind: item.kind,
    title: titleOf(item),
    status: item.status,
    countdownText: countdownTextOf(item),
    isExpired: countdownOf(item).expired,
  })),
)

/** 倒计时展示文案：无时限返回 undefined（不渲染）；超时显示「已超时」，否则剩余秒。 */
function countdownTextOf(item: InteractionRecord): string | undefined {
  if (!countdownOf(item).total) return undefined
  return countdownOf(item).expired
    ? '已超时'
    : `剩余 ${Math.ceil(countdownOf(item).remaining / 1000)}s`
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
  return qs.length > 0 && qs.every((question) => questionAnsweredOf(item, question))
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
    const firstIncomplete = questionsOf(item).find(
      (question) => !questionAnsweredOf(item, question),
    )
    if (firstIncomplete) selectQuestion(item, firstIncomplete.questionId)
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
    now.value = interactions.calibratedNow()
  }, 250)
})
onBeforeUnmount(() => {
  if (countdownTimer !== undefined) clearInterval(countdownTimer)
})
</script>

<template>
  <section
    ref="panelRoot"
    class="pending-panel"
    :class="{ 'is-expanded': expanded, 'has-tasks': scopedPending.length > 0 }"
    aria-label="待操作任务"
  >
    <!-- 状态头：标题（点击收起/展开）+ 进度 + 范围切换 + 刷新，同一行。 -->
    <header class="pending-panel-head">
      <button
        type="button"
        class="pending-panel-toggle"
        :aria-expanded="expanded"
        @click="toggleExpanded"
      >
        <span class="pending-panel-title">
          <span class="pending-panel-glyph" aria-hidden="true">!</span>
          <strong>INTERRUPT // 待操作队列</strong>
          <b v-if="scopedPending.length" class="pending-panel-count">{{ scopedPending.length }}</b>
        </span>
        <span class="pending-panel-toggle-icon" aria-hidden="true">{{ expanded ? '▾' : '▸' }}</span>
      </button>
      <span v-if="scopedPending.length && activeIndex >= 0" class="head-progress">
        {{ activeIndex + 1 }}/{{ scopedPending.length }} 项
      </span>
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
    </header>

    <Transition name="pending-panel-body">
      <div v-if="expanded" class="pending-panel-body">
        <p v-if="submitError || interactions.error" class="pending-panel-error">
          {{ submitError || interactions.error }}
        </p>

        <!-- FOCUS CARD：屏上唯一工作对象，全宽，任务切换 slide 入场。 -->
        <article
          v-if="activeItem"
          ref="focusCardEl"
          :key="activeItem.interactionId"
          class="focus-card"
        >
          <header class="focus-head">
            <span
              class="focus-kind"
              :class="activeItem.kind === 'approval' ? 'is-approval' : 'is-question'"
            >
              {{ activeItem.kind === 'approval' ? '确认' : '回答' }}
            </span>
            <strong class="focus-title">{{ titleOf(activeItem) }}</strong>
            <span
              v-if="countdownOf(activeItem).total"
              class="focus-countdown"
              :class="{ 'is-expired': countdownOf(activeItem).expired }"
            >
              {{ countdownTextOf(activeItem) }}
            </span>
            <span class="focus-status">{{ statusOf(activeItem) }}</span>
            <button type="button" class="locate" @click="emit('locate', activeItem)">
              在节点树中查看 ↗
            </button>
          </header>

          <!-- 审批：概要 / 能力解释 / 技术详情，全宽展示。 -->
          <template v-if="activeItem.kind === 'approval'">
            <ApprovalSummary
              class="approval-overview"
              :sense-name="payload(activeItem).senseName"
              :args="payload(activeItem).arguments"
            />

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

            <details class="technical-details">
              <summary>技术详情</summary>
              <div class="technical-details-body">
                <ParsedArgs :args="payload(activeItem).arguments" title="完整操作参数" embedded />
                <FileChangeDiff :args="payload(activeItem).arguments" embedded />
              </div>
            </details>
          </template>

          <!-- 提问批次：步进器一次一题；选项整卡，备注内嵌卡内；其他补充与单选互斥。 -->
          <div v-else class="question-stage">
            <QuestionStepper
              :questions="questionsOf(activeItem)"
              :active-index="activeQuestionIndex"
              :answered-flags="answeredFlagsOfActiveItem"
              @select="selectActiveQuestionAt"
              @prev="stepQuestion(-1)"
              @next="stepQuestion(1)"
            />
            <fieldset v-if="activeQuestion" :disabled="activeItem.status !== 'pending'">
              <small v-if="activeQuestion.header" class="question-text">{{
                activeQuestion.question
              }}</small>
              <p class="options-hint">
                {{ activeQuestion.multiSelect ? '可多选' : '单选 · 再次点击可取消' }}
              </p>
              <div ref="optionsEl" class="options">
                <div
                  v-for="option in activeQuestion.options"
                  :key="option.label"
                  class="option-card"
                  :class="{
                    'is-selected': draftOf(
                      activeItem,
                      activeQuestion.questionId,
                    ).selectedLabels.includes(option.label),
                  }"
                >
                  <button
                    type="button"
                    class="option-toggle"
                    @click="onOptionClick(activeItem, activeQuestion, option.label)"
                  >
                    <span class="option-mark" aria-hidden="true">{{
                      draftOf(activeItem, activeQuestion.questionId).selectedLabels.includes(
                        option.label,
                      )
                        ? '✓'
                        : ''
                    }}</span>
                    <span class="option-copy">
                      <b>{{ option.label }}</b>
                      <span v-if="option.description">{{ option.description }}</span>
                    </span>
                  </button>
                  <!-- 备注内嵌选项卡内：选中才出现，Flip 补偿兄弟行位移（onOptionClick 调度）。 -->
                  <div
                    v-if="
                      draftOf(activeItem, activeQuestion.questionId).selectedLabels.includes(
                        option.label,
                      )
                    "
                    class="option-note"
                  >
                    <input
                      class="option-note-input"
                      :value="
                        draftOf(activeItem, activeQuestion.questionId).optionNotes[option.label] ??
                        ''
                      "
                      placeholder="为这个选项补充描述（可选）"
                      @input="
                        onOptionNoteInput(
                          activeItem,
                          activeQuestion.questionId,
                          option.label,
                          $event,
                        )
                      "
                    />
                  </div>
                </div>
              </div>
              <input
                class="other-input"
                :value="draftOf(activeItem, activeQuestion.questionId).freeText"
                placeholder="其他补充（可选）"
                @input="onOtherInput(activeItem, activeQuestion.questionId, $event)"
              />
            </fieldset>
          </div>

          <!-- 底部动作栏：两类任务同位（拒绝/接受 | 提交回答），提交前置禁用。 -->
          <footer class="action-bar">
            <span v-if="activeItem.kind === 'question_batch'" class="action-progress">
              已回答 {{ answeredQuestionCountOf(activeItem) }}/{{ questionsOf(activeItem).length }}
            </span>
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
              提交当前任务回答
            </button>
          </footer>
        </article>

        <p v-else class="pending-panel-empty">
          {{ interactions.loading ? '正在加载…' : '没有待操作任务' }}
        </p>

        <!-- QUEUE 队列缩略带：横向 chips 总览 + ←/→ 循环切换。 -->
        <PendingQueueStrip
          :items="queueItems"
          :active-id="activeItem?.interactionId"
          :focused-id="focusedItem?.interactionId"
          @select="activeId = $event"
        />
      </div>
    </Transition>
  </section>
</template>

<style scoped lang="less" src="./PendingOperationsPanel.styles.less"></style>
