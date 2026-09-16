<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useAgentsStore, useInteractionsStore } from '@/application/public'
import type { InteractionRecord } from '@/application/backend/public'
import DecisionDeck from './DecisionDeck.vue'
import InteractionCard from './InteractionCard.vue'
import { belongsToWorkspace } from './interactionScope'
import { questionsOf } from './interactionPresentation'
import { allAnsweredOf, answeredCountOf, draftOf } from './useInteractionDrafts'

const props = withDefaults(
  defineProps<{
    presetId?: string
    rootChatId?: string
    excludeRootChatId?: string
    native?: boolean
    pendingOnly?: boolean
    /** 纸牌堆叠模式（工作台决策窗口）：多个事项批次同时堆叠，一次完整展示一张卡。 */
    stepper?: boolean
  }>(),
  {
    native: false,
    stepper: false,
  },
)
const emit = defineEmits<{
  tree: [rootChatId: string, sourceChatId?: string, interactionId?: string, anchorNodeId?: string]
  /** stepper 模式的批次进度（分页 n/N 由标题栏消费，切换批次卡）。 */
  batchPager: [{ index: number; total: number }]
}>()

const agents = useAgentsStore()
const interactions = useInteractionsStore()
const scope = ref<'workspace' | 'all'>(props.presetId || props.rootChatId ? 'workspace' : 'all')
const section = ref<'pending' | 'activity'>('pending')
/** 审批倒计时驱动：now 每 250ms 刷新，重算各卡剩余秒。 */
const now = ref(interactions.calibratedNow())
let countdownTimer: ReturnType<typeof setInterval> | undefined

const scoped = computed(() => {
  const source =
    props.pendingOnly || section.value === 'pending' ? interactions.pending : interactions.activity
  if (props.excludeRootChatId) return source.filter((item) => item.rootChatId !== props.excludeRootChatId)
  if (!props.pendingOnly && scope.value === 'all') return source
  return source.filter((item) => belongsToWorkspace(item, props.presetId, props.rootChatId))
})
const pendingCount = computed(
  () =>
    interactions.pending.filter(
      (item) => scope.value === 'all' || belongsToWorkspace(item, props.presetId, props.rootChatId),
    ).length,
)

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

async function decide(item: InteractionRecord, action: 'accept' | 'reject'): Promise<void> {
  try {
    await interactions.decide(item, action)
  } catch {
    // The shared store binds the error to this interaction.
  }
}
/** 提交整批回答（纸牌堆叠底部栏与列表卡共用）；提交失败保留草稿，逐题错误由 store 渲染。 */
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

// ── stepper（单卡决策）模式：多个批次同时排队，一次完整展示一张卡；
// 标题栏 ← 批次 n/N → 切换批次卡；卡内题目切换走底部操作栏左侧 ← 题目 n/N →，全部答完才可提交。 ──
const activeIndex = ref(0)
/** 每批次卡内的题目游标（按 interactionId 独立记忆，切换卡片不丢位置）。 */
const questionCursor = reactive<Record<string, number>>({})
const activeItem = computed(() => scoped.value[activeIndex.value] ?? null)
const questionIndex = computed(() => {
  const item = activeItem.value
  if (!item) return 0
  const count = questionsOf(item).length
  return Math.min(questionCursor[item.interactionId] ?? 0, Math.max(count - 1, 0))
})
/** 底部栏 ← 题目 → 切换当前批次卡内的题目（循环）。 */
function step(delta: number): void {
  const item = activeItem.value
  if (!item) return
  const count = questionsOf(item).length
  if (count < 2) return
  questionCursor[item.interactionId] = (questionIndex.value + delta + count) % count
}
/** 标题栏 ← 批次 → 切换批次卡（循环）。 */
function stepBatch(delta: number): void {
  const length = scoped.value.length
  if (length < 2) return
  activeIndex.value = (activeIndex.value + delta + length) % length
}
/** 事项是否属于当前展示的节点树：属于则不显示「在节点树中查看」。 */
function isCurrentTree(item: InteractionRecord): boolean {
  return !!props.rootChatId && item.rootChatId === props.rootChatId
}
function emitTree(item: InteractionRecord): void {
  emit('tree', item.rootChatId, item.chatId, item.interactionId, item.anchorNodeId)
}
// 事项被移除（提交/处理完成）后收缩索引，让下一张卡自然上位
watch(
  () => scoped.value.length,
  (length) => {
    if (activeIndex.value >= length) activeIndex.value = Math.max(0, length - 1)
  },
)
// 标题栏批次进度上报：当前批次 n/N（审批与提问批次统一计数，单批次不显示分页）
watch(
  () => [activeIndex.value, scoped.value.length],
  () => {
    if (!props.stepper) return
    const total = scoped.value.length
    emit('batchPager', total ? { index: activeIndex.value + 1, total } : { index: 0, total: 0 })
  },
  { immediate: true },
)
defineExpose({ stepBatch })

onMounted(() => {
  void interactions.refresh().catch(() => undefined)
  countdownTimer = setInterval(() => {
    now.value = interactions.calibratedNow()
  }, 250)
})
onBeforeUnmount(() => {
  if (countdownTimer) clearInterval(countdownTimer)
})
</script>

<template>
  <section
    class="interaction-inbox"
    :class="{ 'is-native': native, 'is-deck': stepper, 'is-pending-prompt': pendingOnly }"
    aria-label="待处理交互"
  >
    <div v-if="!pendingOnly" class="inbox-toolbar">
      <div class="segmented">
        <button
          type="button"
          :class="{ active: section === 'pending' }"
          @click="section = 'pending'"
        >
          待处理 {{ pendingCount }}
        </button>
        <button
          type="button"
          :class="{ active: section === 'activity' }"
          @click="section = 'activity'"
        >
          最近活动
        </button>
      </div>
      <div v-if="presetId || rootChatId" class="segmented">
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
    <nav
      v-if="native && !pendingOnly && groups.length > 1"
      class="inbox-nav"
      aria-label="待处理会话导航"
    >
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

    <!-- stepper（单卡决策）模式：工作台决策窗口。多个事项批次同时排队，一次完整展示一张卡；
         标题栏 ← 批次 n/N → 切换批次卡；卡内 ← 题目 n/N → 固定在底部操作栏左侧；提交后卡片淡出消失。 -->
    <template v-if="stepper">
      <div class="decision-deck">
        <DecisionDeck
          :items="scoped"
          :active-index="activeIndex"
          :question-index="questionIndex"
          :now="now"
        />
        <p v-if="scoped.length === 0" class="empty">
          {{ interactions.loading ? '正在加载…' : '没有待处理交互' }}
        </p>
      </div>

      <!-- 固定底部操作栏：单独一行；左侧为题目切换（提问批次始终显示），已是当前节点树的事项不显示「在节点树中查看」。 -->
      <footer v-if="activeItem" class="decision-bar">
        <div
          v-if="activeItem.kind === 'question_batch'"
          class="question-switch"
          role="group"
          aria-label="切换批次内题目"
        >
          <button type="button" aria-label="上一题" :disabled="questionIndex <= 0" @click="step(-1)">
            ←
          </button>
          <span class="question-switch-index" aria-live="polite"
            >题目 {{ questionIndex + 1 }}/{{ questionsOf(activeItem).length }}</span
          >
          <button
            type="button"
            aria-label="下一题"
            :disabled="questionIndex >= questionsOf(activeItem).length - 1"
            @click="step(1)"
          >
            →
          </button>
        </div>
        <button v-if="!isCurrentTree(activeItem)" type="button" class="locate" @click="emitTree(activeItem)">
          在节点树中查看
        </button>
        <template v-if="activeItem.kind === 'approval'">
          <span class="decision-spacer" />
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
        <template v-else>
          <span class="decision-progress"
            >已完成 {{ answeredCountOf(activeItem) }}/{{ questionsOf(activeItem).length }} 题</span
          >
          <span class="decision-spacer" />
          <button
            type="button"
            class="accept submit"
            :disabled="activeItem.status !== 'pending' || !allAnsweredOf(activeItem)"
            @click="answer(activeItem)"
          >
            {{ allAnsweredOf(activeItem) ? '提交回答' : '请完成全部问题' }}
          </button>
        </template>
      </footer>
    </template>

    <!-- 列表模式（会话浏览器 / 待处理抽屉）：多卡列表 + 卡内操作 -->
    <div v-else ref="listEl" class="inbox-list">
      <section
        v-for="group in displayGroups"
        :key="group.id"
        :ref="native ? (el) => bindGroupEl(group.id, el) : undefined"
        class="inbox-group"
      >
        <h4
          v-if="native && !pendingOnly"
          class="group-head"
          title="滚动定位到本会话"
          @click="scrollToGroup(group.id)"
        >
          {{ group.name }}<span class="group-count">{{ group.items.length }}</span>
        </h4>
        <InteractionCard
          v-for="item in group.items"
          :key="item.interactionId"
          :item="item"
          :now="now"
          :pending-only="pendingOnly"
          :section="section"
          @tree="emitTree(item)"
          @decide="(action) => decide(item, action)"
          @answer="answer(item)"
        />
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
  gap: 7px;
  margin-bottom: 10px;
  overflow-x: auto;
  .inner-scrollbar();
}
.nav-chip {
  flex: none;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 38%, transparent);
  border-radius: 999px;
  background: transparent;
  color: var(--ink);
  font-size: 12px;
  cursor: pointer;
}
.nav-chip b {
  padding: 0 5px;
  border-radius: 999px;
  background: #d88a26;
  color: white;
  font-weight: 400;
}
.group-head {
  margin: 0 0 6px;
  padding: 0 2px;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.group-count {
  margin-left: 4px;
  opacity: 0.6;
}
.inbox-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 7px;
  margin-bottom: 10px;
}
.segmented {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 2px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 999px;
}
.segmented button {
  padding: 3px 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ink);
  font-size: 12px;
  cursor: pointer;
}
.segmented button.active {
  background: var(--accent);
  color: #fff;
  font-weight: 400;
}
.refresh {
  padding: 4px 8px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--ink);
  font-size: 13px;
  cursor: pointer;
}
.refresh:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.inbox-list {
  height: 100%;
  max-height: min(480px, 100%);
  overflow: auto;
  .inner-scrollbar();
}

// ── stepper（纸牌堆叠）决策窗口：整窗布局（堆叠区滚动 + 底部操作栏固定） ──
.interaction-inbox.is-deck {
  height: 100%;
  min-height: 0;
  flex: 1 1 auto;
  display: flex;
  flex-direction: column;
  padding: 0;
  overflow: hidden;
}
.decision-deck {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 14px;
  .inner-scrollbar();
}
// 固定底部操作栏：单独一行高度，不随卡内容滚动。
.decision-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 46px;
  padding: 7px 14px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: var(--surface);
}
.decision-bar button {
  padding: 6px 13px;
  border: 0;
  border-radius: 0;
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
}
.decision-bar .locate {
  margin-right: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
}
.decision-bar .reject {
  background: color-mix(in srgb, #e35a49 14%, var(--surface));
  color: #b74438;
}
.decision-bar .accept {
  background: #d88a26;
  color: white;
}
.decision-spacer {
  flex: 1;
}
.decision-progress {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: color-mix(in srgb, var(--ink) 60%, transparent);
}
// 底部栏左侧题目切换（与提交按钮同一行）：直角分页器，与标题栏批次分页同风格。
.decision-bar .question-switch {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 2px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
}
.decision-bar .question-switch button {
  min-width: 24px;
  padding: 3px 5px;
  border: 0;
  border-radius: 0;
  background: transparent;
  color: var(--ink);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.decision-bar .question-switch button:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ink) 10%, transparent);
}
.decision-bar .question-switch button:disabled {
  cursor: not-allowed;
  opacity: 0.38;
}
.decision-bar .question-switch-index {
  min-width: 46px;
  text-align: center;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
}
.decision-bar button:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.error {
  padding: 7px;
  border-radius: 8px;
  background: color-mix(in srgb, #e35a49 13%, var(--surface));
  color: #b74438;
  font-size: 12px;
}
.empty {
  margin: 48px 0;
  text-align: center;
  opacity: 0.55;
  font-size: 13px;
}
</style>
