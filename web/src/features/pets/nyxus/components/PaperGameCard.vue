<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef, type Ref } from 'vue'
import { renderMarkdown } from '@/utils/markdown'
import QuestionCard from '@/features/agent/cards/QuestionCard.vue'
import type { ExecutionNode } from '../graph/executionGraph'
import type { NodePopoverQuestion } from '../graph/nodePopoverModel'
import type {
  PaperDetailBlock,
  PaperGameCardModel,
  PaperProcessStage,
} from '../paper/paperCardModel'
import { buildPaperGameCard } from '../paper/paperCardModel'
import PaperPixelIcon from './PaperPixelIcon.vue'
import ToolFieldTree from './ToolFieldTree.vue'

const DETAIL_PREVIEW_LIMIT = 12_000
const MARKDOWN_UPDATE_INTERVAL_MS = 240
const props = defineProps<{
  model: PaperGameCardModel
  maxHeight: number
  quietMotion?: boolean
  detailBranchAvailable?: boolean
  detailBranchUnavailableReason?: string
  node?: ExecutionNode
  foldNode?: ExecutionNode
  chatId?: string
  question?: NodePopoverQuestion
  questionNodeId?: string
}>()

const emit = defineEmits<{
  selectCall: [callId: string]
  branch: [type: 'detail' | 'continuation']
}>()

const rootRef = ref<HTMLElement>()
const activeDetailId = ref('')
const pinnedDetailId = ref('')
const activeStageId = ref('')
const pinnedStageId = ref('')
const selectedStageCalls = ref(new Map<string, string>())
const copied = ref(false)
let previewTimer: ReturnType<typeof setTimeout> | undefined
let closeTimer: ReturnType<typeof setTimeout> | undefined
let copyTimer: ReturnType<typeof setTimeout> | undefined
const markdownTimers = new Set<ReturnType<typeof setTimeout>>()

const isAdventurer = computed(() => props.model.kind === 'adventurer')
const inlineMessageDetail = computed(() =>
  isAdventurer.value ? props.model.details.find((detail) => detail.kind === 'content') : undefined,
)
const inlineMessageSource = computed(() => inlineMessageDetail.value?.content ?? '')
const renderedInlineMessage = useThrottledMarkdown(inlineMessageSource, false)
/** 普通节点卡：秘法推演入住属性行空位格，交互仍走侧边卡。 */
const thinkingDetail = computed(() =>
  props.model.details.find((detail) => detail.kind === 'thinking'),
)
/** 普通节点卡：情报栏专用正文，内联渲染不走弹窗。 */
const inlineContentDetail = computed(() =>
  props.model.details.find((detail) => detail.kind === 'content'),
)
const inlineContentSource = computed(() => {
  const detail = inlineContentDetail.value
  return detail?.format === 'markdown' ? detail.content : ''
})
const renderedInlineContent = useThrottledMarkdown(inlineContentSource)
/** 技能实录栏：铭文/产物保留按钮 + 侧边卡弹窗交互。 */
const popupDetails = computed(() =>
  props.model.details.filter((detail) => detail.kind !== 'content' && detail.kind !== 'thinking'),
)
const activeStage = computed<PaperProcessStage | undefined>(() =>
  props.model.processStages?.find((stage) => stage.id === activeStageId.value),
)
const activeDetail = computed(() =>
  props.model.details.find((detail) => detail.id === activeDetailId.value),
)
const detailPanelId = computed(() => `paper-detail-${safeId(props.model.id)}`)
const activeStageCallId = computed(() => {
  const stage = activeStage.value
  if (!stage) return undefined
  return selectedStageCalls.value.get(stage.id) ?? stage.calls[0]?.id
})
const activeStageStyle = computed(() => {
  const stage = activeStage.value
  const total = props.model.processStages?.length ?? 1
  if (!stage) return undefined
  const position = total <= 1 ? 45 : 18 + (stage.index / (total - 1)) * 64
  return { '--stage-anchor-y': `${Math.round(position)}%` }
})
const activeStageCard = computed(() => {
  const stage = activeStage.value
  if (!stage) return undefined
  return buildPaperGameCard(stage.node, {
    ...stage.cardOptions,
    selectedCallId: activeStageCallId.value,
  })
})
const currentQuestion = computed(() =>
  props.question && props.node && props.questionNodeId === props.node.id
    ? props.question
    : undefined,
)
const batchInfo = computed(() => {
  const current = currentQuestion.value
  if (!current) return null
  return {
    batchId: current.batch.batchId,
    total: current.batch.questions.length,
    readyCount: current.batch.questions.filter((question) => question.localStatus === 'ready')
      .length,
    currentIndex: current.currentIndex,
    isLast: current.currentIndex === current.batch.questions.length - 1,
  }
})
const detailMarkdownSource = computed(() => {
  const detail = activeDetail.value
  return detail?.format === 'markdown' ? detail.content : ''
})
const renderedDetail = useThrottledMarkdown(detailMarkdownSource)

watch(
  () => props.model.id,
  () => closeDetail(),
)

watch(
  () => props.model.selectedSkillId,
  () => {
    if (
      activeDetailId.value &&
      !props.model.details.some((item) => item.id === activeDetailId.value)
    ) {
      closeDetail()
    }
  },
)

onMounted(() => {
  window.addEventListener('pointerdown', onWindowPointerDown)
  window.addEventListener('keydown', onWindowKeydown)
})
onBeforeUnmount(() => {
  clearTimers()
  for (const timer of markdownTimers) clearTimeout(timer)
  markdownTimers.clear()
  window.removeEventListener('pointerdown', onWindowPointerDown)
  window.removeEventListener('keydown', onWindowKeydown)
})

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
}

/** 超长 markdown 截断到预览上限后渲染，弹窗与内联正文共用。 */
function renderMarkdownCapped(content: string): string {
  const capped =
    content.length > DETAIL_PREVIEW_LIMIT
      ? `${content.slice(0, DETAIL_PREVIEW_LIMIT)}\n\n> 内容较长，当前展示前半部分。`
      : content
  return renderMarkdown(capped)
}

/** Keep markdown parsing/DOM replacement well outside the 16.7ms interaction budget. */
function useThrottledMarkdown(source: ComputedRef<string>, capped = true): Ref<string> {
  const rendered = ref('')
  let latest = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  const render = (): void => {
    if (timer) markdownTimers.delete(timer)
    timer = undefined
    rendered.value = latest ? (capped ? renderMarkdownCapped(latest) : renderMarkdown(latest)) : ''
  }
  watch(
    source,
    (content) => {
      latest = content
      if (!rendered.value && content) {
        render()
        return
      }
      if (timer) return
      timer = setTimeout(render, MARKDOWN_UPDATE_INTERVAL_MS)
      markdownTimers.add(timer)
    },
    { immediate: true },
  )
  return rendered
}

function clearTimers(): void {
  if (previewTimer) clearTimeout(previewTimer)
  if (closeTimer) clearTimeout(closeTimer)
  if (copyTimer) clearTimeout(copyTimer)
}

function openPreview(detail: PaperDetailBlock): void {
  if (!finePointerHover()) return
  if (pinnedDetailId.value) return
  if (closeTimer) clearTimeout(closeTimer)
  if (previewTimer) clearTimeout(previewTimer)
  previewTimer = setTimeout(() => {
    activeDetailId.value = detail.id
  }, 140)
}

function focusPreview(detail: PaperDetailBlock): void {
  if (pinnedDetailId.value) return
  if (previewTimer) clearTimeout(previewTimer)
  if (closeTimer) clearTimeout(closeTimer)
  activeDetailId.value = detail.id
}

function finePointerHover(): boolean {
  return (
    typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches
  )
}

function schedulePreviewClose(): void {
  if (pinnedDetailId.value) return
  if (previewTimer) clearTimeout(previewTimer)
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    activeDetailId.value = ''
  }, 180)
}

function keepDetailOpen(): void {
  if (closeTimer) clearTimeout(closeTimer)
}

function openStagePreview(stage: PaperProcessStage, immediate = false): void {
  if (!immediate && !finePointerHover()) return
  if (pinnedStageId.value) return
  if (closeTimer) clearTimeout(closeTimer)
  if (previewTimer) clearTimeout(previewTimer)
  const open = () => {
    activeStageId.value = stage.id
    activeDetailId.value = ''
  }
  if (immediate) open()
  else previewTimer = setTimeout(open, 140)
}

function scheduleStageClose(): void {
  if (pinnedStageId.value) return
  if (previewTimer) clearTimeout(previewTimer)
  if (closeTimer) clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    activeStageId.value = ''
  }, 150)
}

function toggleStage(stage: PaperProcessStage): void {
  if (previewTimer) clearTimeout(previewTimer)
  if (closeTimer) clearTimeout(closeTimer)
  if (pinnedStageId.value === stage.id) {
    closeStage()
    return
  }
  activeDetailId.value = ''
  pinnedDetailId.value = ''
  activeStageId.value = stage.id
  pinnedStageId.value = stage.id
}

function closeStage(): void {
  activeStageId.value = ''
  pinnedStageId.value = ''
}

function selectStageCall(stageId: string, callId: string): void {
  const next = new Map(selectedStageCalls.value)
  next.set(stageId, callId)
  selectedStageCalls.value = next
}

function togglePinned(detail: PaperDetailBlock): void {
  if (previewTimer) clearTimeout(previewTimer)
  if (closeTimer) clearTimeout(closeTimer)
  if (pinnedDetailId.value === detail.id) {
    closeDetail()
    return
  }
  activeDetailId.value = detail.id
  pinnedDetailId.value = detail.id
}

function closeDetail(): void {
  clearTimers()
  activeDetailId.value = ''
  pinnedDetailId.value = ''
  activeStageId.value = ''
  pinnedStageId.value = ''
  copied.value = false
}

function onWindowPointerDown(event: PointerEvent): void {
  if (!pinnedDetailId.value && !pinnedStageId.value) return
  if (rootRef.value?.contains(event.target as Node)) return
  closeDetail()
}

function onWindowKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && (activeDetailId.value || activeStageId.value)) closeDetail()
}

async function copyDetail(): Promise<void> {
  const content = activeDetail.value?.content
  if (!content) return
  try {
    await navigator.clipboard?.writeText(content)
    copied.value = true
  } catch {
    copied.value = false
  }
  if (copyTimer) clearTimeout(copyTimer)
  copyTimer = setTimeout(() => {
    copied.value = false
  }, 1200)
}
</script>

<template>
  <div
    ref="rootRef"
    class="paper-game-card"
    :class="[
      `is-${model.kind}`,
      {
        'has-detail': activeDetail,
        'has-pinned-detail': pinnedDetailId || pinnedStageId,
        'is-quiet-motion': quietMotion,
      },
    ]"
    @keydown.esc.stop="closeDetail"
  >
    <div class="scroll-roller is-top" aria-hidden="true"><span /><i /><span /></div>

    <section class="game-card-face" :style="{ maxHeight: `${maxHeight}px` }">
      <div class="pixel-spark-field" aria-hidden="true">
        <i v-for="index in 7" :key="index" :class="`spark-${index}`" />
      </div>

      <header class="game-card-header">
        <span class="portrait-frame" aria-hidden="true">
          <PaperPixelIcon :name="model.icon" />
        </span>
        <span class="identity-copy">
          <small>{{ model.kicker }}</small>
          <strong>{{ model.title }}</strong>
        </span>
        <span class="card-sequence">{{ model.sequence }}</span>
      </header>

      <div class="status-ribbon" :class="`tone-${model.statusTone}`">
        <PaperPixelIcon name="shield" />
        <span>{{ model.status }}</span>
        <i />
        <time v-if="model.time">
          <PaperPixelIcon name="clock" />
          {{ model.time }}
        </time>
      </div>

      <div class="card-scroll-body">
        <section v-if="currentQuestion && chatId" class="paper-inline-question">
          <QuestionCard
            :question="currentQuestion.question"
            :chat-id="chatId"
            :batch-info="batchInfo"
            variant="paper"
          />
        </section>

        <!-- 过程组：按发生顺序串成流程，批量工具仍为一个阶段。 -->
        <template v-if="model.processStages?.length">
          <div class="stat-grid" aria-label="节点属性">
            <div v-for="stat in model.stats" :key="stat.id" class="stat-tile">
              <PaperPixelIcon :name="stat.icon" />
              <span
                ><small>{{ stat.label }}</small
                ><strong>{{ stat.value }}</strong></span
              >
            </div>
          </div>

          <section class="process-stage" aria-label="任务过程">
            <header>
              <span>任务过程</span
              ><small>{{ model.processStages.length }} 个阶段 · 悬浮预览 / 点击固定</small>
            </header>
            <ol class="process-stage-list">
              <li
                v-for="(stage, stageIndex) in model.processStages"
                :key="stage.id"
                class="process-step"
                :class="[`tone-${stage.tone}`, { active: stage.id === activeStageId }]"
              >
                <span class="process-step-rail" aria-hidden="true">
                  <i>{{ stageIndex + 1 }}</i>
                </span>
                <button
                  type="button"
                  class="process-step-trigger"
                  :aria-expanded="stage.id === activeStageId"
                  @pointerenter="openStagePreview(stage)"
                  @pointerleave="scheduleStageClose"
                  @focus="openStagePreview(stage, true)"
                  @blur="scheduleStageClose"
                  @click="toggleStage(stage)"
                >
                  <span class="process-step-icon">
                    <PaperPixelIcon :name="stage.icon" />
                  </span>
                  <span class="process-step-copy">
                    <span
                      class="process-name-viewport"
                      :class="{ 'is-looping': stage.calls.length > 1 }"
                    >
                      <span class="process-name-track">
                        <strong v-if="!stage.calls.length">{{ stage.label }}</strong>
                        <strong v-for="call in stage.calls" :key="call.id">{{ call.label }}</strong>
                        <template v-if="stage.calls.length > 1">
                          <strong
                            v-for="call in stage.calls"
                            :key="`${call.id}:clone`"
                            aria-hidden="true"
                            >{{ call.label }}</strong
                          >
                        </template>
                      </span>
                    </span>
                    <small>{{ stage.summary }}</small>
                  </span>
                  <span class="process-step-status">{{ stage.status }}</span>
                  <span class="detail-arrow" aria-hidden="true">›</span>
                </button>
              </li>
            </ol>
          </section>
        </template>

        <!-- 冒险指令卡：状态/关联 + 完整消息 -->
        <template v-else-if="isAdventurer">
          <div class="stat-grid" aria-label="节点属性">
            <div v-for="stat in model.stats" :key="stat.id" class="stat-tile">
              <PaperPixelIcon :name="stat.icon" />
              <span
                ><small>{{ stat.label }}</small
                ><strong>{{ stat.value }}</strong></span
              >
            </div>
          </div>

          <section v-if="inlineMessageDetail" class="adventurer-message" aria-label="冒险指令">
            <span class="section-rune" aria-hidden="true"
              ><PaperPixelIcon name="adventurer"
            /></span>
            <div>
              <small>冒险指令</small>
              <div class="markdown-body" v-html="renderedInlineMessage" />
            </div>
          </section>

          <section v-if="model.skills.length" class="skill-section">
            <header>
              <span>技能槽</span><small>{{ model.skills.length }} 项</small>
            </header>
            <div class="skill-slots" role="list" aria-label="工具技能">
              <button
                v-for="skill in model.skills"
                :key="skill.id"
                type="button"
                disabled
                :class="`status-${skill.status}`"
              >
                <PaperPixelIcon :name="skill.icon" />
                <span>{{ skill.label }}</span>
                <i aria-hidden="true" />
              </button>
            </div>
          </section>
        </template>

        <!-- 普通节点卡：记录摘要 → 属性行（含推演格）→ 情报栏（正文专栏）→ 技能槽 → 技能实录 -->
        <template v-else>
          <section class="quest-summary">
            <span class="section-rune" aria-hidden="true"><PaperPixelIcon name="quill" /></span>
            <div>
              <small>记录摘要</small>
              <p>{{ model.summary }}</p>
            </div>
          </section>

          <div class="stat-grid" aria-label="节点属性">
            <div v-for="stat in model.stats" :key="stat.id" class="stat-tile">
              <PaperPixelIcon :name="stat.icon" />
              <span
                ><small>{{ stat.label }}</small
                ><strong>{{ stat.value }}</strong></span
              >
            </div>
            <!-- 秘法推演：占属性行空位格（满 3 格时自动换行为第 4 格），弹侧边卡看全文 -->
            <button
              v-if="thinkingDetail"
              type="button"
              class="stat-tile is-thinking"
              :class="{
                active: thinkingDetail.id === activeDetailId,
                pinned: thinkingDetail.id === pinnedDetailId,
              }"
              :aria-expanded="thinkingDetail.id === activeDetailId"
              :aria-controls="detailPanelId"
              @pointerenter="openPreview(thinkingDetail)"
              @pointerleave="schedulePreviewClose"
              @focus="focusPreview(thinkingDetail)"
              @blur="schedulePreviewClose"
              @click="togglePinned(thinkingDetail)"
            >
              <PaperPixelIcon :name="thinkingDetail.icon" />
              <span
                ><small>{{ thinkingDetail.title }}</small
                ><strong>{{ thinkingDetail.hint }}</strong></span
              >
            </button>
          </div>

          <!-- 情报栏：专做正文内联展示，不再经侧边卡弹窗 -->
          <section v-if="inlineContentDetail" class="detail-section content-section">
            <header><span>情报栏</span><small>正文全览</small></header>
            <div class="inline-content" v-html="renderedInlineContent" />
          </section>

          <section v-if="model.skills.length" class="skill-section">
            <header>
              <span>技能槽</span><small>{{ model.skills.length }} 项</small>
            </header>
            <div class="skill-slots" role="tablist" aria-label="工具技能">
              <button
                v-for="skill in model.skills"
                :key="skill.id"
                type="button"
                role="tab"
                :aria-selected="skill.id === model.selectedSkillId"
                :class="[`status-${skill.status}`, { active: skill.id === model.selectedSkillId }]"
                @click="emit('selectCall', skill.id)"
              >
                <PaperPixelIcon :name="skill.icon" />
                <span>{{ skill.label }}</span>
                <i aria-hidden="true" />
              </button>
            </div>
          </section>

          <!-- 技能实录：铭文/产物按钮，悬浮预览 / 点击钉住弹侧边卡 -->
          <section v-if="popupDetails.length" class="detail-section">
            <header><span>技能实录</span><small>悬浮预览 · 点击钉住</small></header>
            <div class="detail-grid">
              <button
                v-for="detail in popupDetails"
                :key="detail.id"
                type="button"
                class="detail-tile"
                :class="[
                  `tone-${detail.tone ?? 'default'}`,
                  { active: detail.id === activeDetailId, pinned: detail.id === pinnedDetailId },
                ]"
                :aria-expanded="detail.id === activeDetailId"
                :aria-controls="detailPanelId"
                @pointerenter="openPreview(detail)"
                @pointerleave="schedulePreviewClose"
                @focus="focusPreview(detail)"
                @blur="schedulePreviewClose"
                @click="togglePinned(detail)"
              >
                <span class="detail-icon"><PaperPixelIcon :name="detail.icon" /></span>
                <span class="detail-copy">
                  <strong>{{ detail.title }}</strong>
                  <small>{{ detail.hint }}</small>
                </span>
                <span class="detail-arrow" aria-hidden="true">›</span>
              </button>
            </div>
          </section>
        </template>
      </div>

      <footer class="game-card-footer">
        <span v-if="model.termination" class="termination-seal">
          <PaperPixelIcon name="warning" />{{ model.termination.label }}
        </span>
        <div
          v-if="model.canBranch"
          class="branch-actions"
          role="group"
          aria-label="从此节点发起对话"
        >
          <button
            type="button"
            :disabled="detailBranchAvailable === false"
            :title="
              detailBranchAvailable === false ? detailBranchUnavailableReason : '创建解释分支'
            "
            @click="emit('branch', 'detail')"
          >
            <PaperPixelIcon name="magic" />解释
          </button>
          <button type="button" @click="emit('branch', 'continuation')">
            <PaperPixelIcon name="quill" />续写
          </button>
        </div>
      </footer>
    </section>

    <div class="scroll-roller is-bottom" aria-hidden="true"><span /><i /><span /></div>

    <Transition name="side-card">
      <aside
        v-if="activeDetail"
        :id="detailPanelId"
        class="paper-side-card"
        :class="[`is-${activeDetail.tone ?? 'default'}`, { 'is-pinned': pinnedDetailId }]"
        role="dialog"
        :aria-label="activeDetail.title"
        @pointerenter="keepDetailOpen"
        @pointerleave="schedulePreviewClose"
        @wheel.stop
      >
        <header>
          <span><PaperPixelIcon :name="activeDetail.icon" /></span>
          <div>
            <small>{{ pinnedDetailId ? '已钉住的情报' : '情报预览' }}</small
            ><strong>{{ activeDetail.title }}</strong>
          </div>
          <button type="button" aria-label="关闭情报卡" @click="closeDetail">×</button>
        </header>
        <div class="side-card-body">
          <ToolFieldTree v-if="activeDetail.fields?.length" :fields="activeDetail.fields" />
          <div
            v-else-if="activeDetail.format === 'markdown'"
            class="markdown-body"
            v-html="renderedDetail"
          />
          <pre
            v-else-if="activeDetail.format === 'code'"
          ><code>{{ activeDetail.content }}</code></pre>
          <p v-else class="plain-detail">{{ activeDetail.content }}</p>
        </div>
        <footer>
          <span>{{ activeDetail.content.length.toLocaleString() }} 字符</span>
          <button type="button" @click="copyDetail">
            <PaperPixelIcon name="scroll" />{{ copied ? '已抄录' : '抄录全文' }}
          </button>
        </footer>
      </aside>
    </Transition>

    <!-- 过程组后续窗口直接复用第一层的完整 PaperGameCard，不添加专属窗口。 -->
    <Transition name="side-card">
      <div
        v-if="activeStage"
        class="paper-member-card"
        :class="{ 'is-pinned': pinnedStageId }"
        :style="activeStageStyle"
        @pointerenter="keepDetailOpen"
        @pointerleave="scheduleStageClose"
        @wheel.stop
      >
        <PaperGameCard
          :model="activeStageCard!"
          :node="activeStage.node"
          :max-height="maxHeight"
          :quiet-motion="quietMotion"
          :chat-id="chatId"
          :question="questionNodeId === activeStage.node.id ? question : undefined"
          :question-node-id="questionNodeId"
          :detail-branch-available="detailBranchAvailable"
          :detail-branch-unavailable-reason="detailBranchUnavailableReason"
          @select-call="selectStageCall(activeStage.id, $event)"
          @branch="emit('branch', $event)"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="less">
@import '@/styles/markdown.less';

.paper-game-card {
  --card-accent: #d9a94e;
  --card-accent-bright: #f5d77d;
  --card-ink: #342312;
  --card-paper: #d9bd80;
  --card-paper-light: #edd9a8;
  --card-paper-dark: #9a6d3f;
  --paper-font-caption: 10px;
  --paper-font-small: 11px;
  --paper-font-label: 12px;
  --paper-font-body: 13px;
  --paper-font-title: 16px;
  position: relative;
  width: 100%;
  height: 100%;
  color: var(--card-ink);
  font-synthesis: none;
  isolation: isolate;
}

.paper-game-card.is-arcanist {
  --card-accent: #7069b8;
  --card-accent-bright: #b9b1f2;
  --card-paper: #a7a2bd;
  --card-paper-light: #d1cadd;
  --card-paper-dark: #514b78;
  --card-ink: #242039;
}
.paper-game-card.is-companion,
.paper-game-card.is-quest {
  --card-accent: #9e5986;
  --card-accent-bright: #e3a2cc;
  --card-paper: #c0a0b0;
  --card-paper-light: #e4c9d4;
  --card-paper-dark: #70415f;
  --card-ink: #361c2f;
}
.paper-game-card.is-skill {
  --card-accent: #a97a35;
  --card-accent-bright: #f3c66e;
  --card-paper: #9c9687;
  --card-paper-light: #cbc4ad;
  --card-paper-dark: #555149;
  --card-ink: #29251d;
}
.paper-game-card.is-treasure {
  --card-accent: #6b9664;
  --card-accent-bright: #badb8a;
  --card-paper: #b7aa76;
  --card-paper-light: #e0d5a1;
  --card-paper-dark: #5d7048;
}
.paper-game-card.is-notice,
.paper-game-card.is-anomaly {
  --card-accent: #9d5145;
  --card-accent-bright: #e8997d;
  --card-paper: #b59572;
  --card-paper-light: #dac49c;
  --card-paper-dark: #68453a;
}
.paper-game-card.is-journal {
  --card-accent: #548d96;
  --card-accent-bright: #9bd2d2;
  --card-paper: #a9b4a3;
  --card-paper-light: #d5ddc5;
  --card-paper-dark: #48666a;
}
.paper-inline-question {
  margin: 4px 0 10px;
}
.paper-inline-question :deep(.question-card) {
  width: auto;
  max-width: none;
  box-shadow: none;
}

.game-card-face {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-rows: auto auto minmax(0, 1fr) auto;
  width: 100%;
  height: 100%;
  overflow: hidden;
  border: 4px solid #2b1b0f;
  background:
    linear-gradient(90deg, transparent 0 6px, rgba(255, 255, 255, 0.13) 6px 8px, transparent 8px),
    repeating-linear-gradient(0deg, transparent 0 7px, rgba(70, 42, 19, 0.055) 7px 8px),
    var(--card-paper);
  box-shadow:
    0 0 0 2px var(--card-accent-bright),
    0 0 0 6px #2b1b0f,
    inset 0 0 0 4px color-mix(in srgb, var(--card-paper-dark) 56%, transparent),
    inset 0 0 38px rgba(58, 32, 14, 0.22);
  clip-path: polygon(
    4px 0,
    calc(100% - 4px) 0,
    calc(100% - 4px) 2px,
    100% 2px,
    100% calc(100% - 4px),
    calc(100% - 4px) calc(100% - 4px),
    calc(100% - 4px) 100%,
    4px 100%,
    4px calc(100% - 2px),
    0 calc(100% - 2px),
    0 4px,
    4px 4px
  );
}

.game-card-face::before,
.game-card-face::after {
  content: '';
  position: absolute;
  z-index: 8;
  width: 18px;
  height: 18px;
  border-color: var(--card-accent-bright);
  pointer-events: none;
}
.game-card-face::before {
  top: 9px;
  left: 9px;
  border-top: 4px solid;
  border-left: 4px solid;
}
.game-card-face::after {
  right: 9px;
  bottom: 9px;
  border-right: 4px solid;
  border-bottom: 4px solid;
}

.scroll-roller {
  position: absolute;
  z-index: 9;
  right: -10px;
  left: -10px;
  display: grid;
  grid-template-columns: 18px 1fr 18px;
  align-items: center;
  height: 15px;
  pointer-events: none;
}
.scroll-roller.is-top {
  top: -11px;
}
.scroll-roller.is-bottom {
  bottom: -11px;
}
.scroll-roller span {
  height: 11px;
  border: 3px solid #27180e;
  background: var(--card-accent);
  box-shadow: inset 2px 0 var(--card-accent-bright);
}
.scroll-roller i {
  height: 8px;
  border-block: 3px solid #27180e;
  background: var(--card-paper-dark);
}

.game-card-header {
  position: relative;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  min-height: 64px;
  padding: 9px 13px 7px;
  border-bottom: 4px solid #2b1b0f;
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--card-accent) 38%, transparent),
      transparent 58%
    ),
    color-mix(in srgb, var(--card-paper-dark) 58%, var(--card-paper));
}
.portrait-frame {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 3px solid #2a190d;
  color: var(--card-accent-bright);
  background: color-mix(in srgb, var(--card-paper-dark) 72%, #17100b);
  box-shadow:
    inset 0 0 0 3px var(--card-accent),
    3px 3px 0 rgba(35, 20, 10, 0.38);
  font-size: 28px;
}
.identity-copy {
  min-width: 0;
}
.identity-copy small,
.section-rune + div > small {
  display: block;
  color: color-mix(in srgb, var(--card-ink) 70%, var(--card-accent));
  font-size: var(--paper-font-small);
  font-weight: 900;
  letter-spacing: 0.16em;
}
.identity-copy strong {
  display: block;
  overflow: hidden;
  margin-top: 3px;
  font-size: var(--paper-font-title);
  font-weight: 950;
  letter-spacing: 0.05em;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.card-sequence {
  align-self: start;
  padding: 4px 5px;
  border: 2px solid #382313;
  color: var(--card-accent-bright);
  background: #382313;
  font:
    900 var(--paper-font-small) / 1 ui-monospace,
    monospace;
}

.status-ribbon {
  display: flex;
  align-items: center;
  gap: 5px;
  min-height: 30px;
  padding: 4px 12px;
  border-bottom: 3px solid #2c1c10;
  color: #f4e2b4;
  background: #4d3b2a;
  font-size: var(--paper-font-small);
  font-weight: 900;
  letter-spacing: 0.08em;
}
.status-ribbon > svg {
  width: 13px;
  height: 13px;
  color: var(--card-accent-bright);
}
.status-ribbon > i {
  flex: 1;
  height: 2px;
  background: repeating-linear-gradient(90deg, var(--card-accent) 0 4px, transparent 4px 7px);
}
.status-ribbon time {
  display: flex;
  align-items: center;
  gap: 4px;
  font-style: normal;
}
.status-ribbon time svg {
  width: 11px;
  height: 11px;
}
.status-ribbon.tone-active {
  background: #5b4b29;
}
.status-ribbon.tone-success {
  background: #385240;
}
.status-ribbon.tone-danger {
  background: #693b34;
}

.card-scroll-body {
  min-height: 0;
  padding: 10px 11px 14px;
  overflow: auto;
  scrollbar-color: var(--card-accent) color-mix(in srgb, var(--card-paper-dark) 50%, transparent);
  scrollbar-width: thin;
}
.quest-summary {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 8px;
  padding: 8px;
  border: 3px double color-mix(in srgb, var(--card-ink) 76%, var(--card-accent));
  background: color-mix(in srgb, var(--card-paper-light) 72%, transparent);
  box-shadow: 3px 3px 0 color-mix(in srgb, var(--card-paper-dark) 45%, transparent);
}
.section-rune {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--card-accent);
  background: color-mix(in srgb, var(--card-ink) 88%, #000);
  font-size: 18px;
}
.quest-summary p {
  display: -webkit-box;
  margin: 4px 0 0;
  overflow: hidden;
  font-size: var(--paper-font-body);
  font-weight: 700;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.adventurer-message {
  display: grid;
  grid-template-columns: 30px 1fr;
  gap: 8px;
  margin-top: 8px;
  padding: 8px;
  border: 3px double color-mix(in srgb, #6b9664 78%, var(--card-ink));
  background: color-mix(in srgb, var(--card-paper-light) 72%, transparent);
  box-shadow: 3px 3px 0 color-mix(in srgb, var(--card-paper-dark) 45%, transparent);
}
.adventurer-message small {
  display: block;
  margin-bottom: 4px;
  font-size: var(--paper-font-small);
  font-weight: 950;
  opacity: 0.72;
}
.adventurer-message .markdown-body {
  font-size: var(--paper-font-body);
  line-height: 1.6;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
  margin-top: 8px;
}
.stat-tile {
  display: flex;
  align-items: center;
  min-width: 0;
  gap: 5px;
  padding: 5px;
  border: 2px solid color-mix(in srgb, var(--card-ink) 74%, var(--card-accent));
  background: color-mix(in srgb, var(--card-paper-dark) 20%, var(--card-paper-light));
}
.stat-tile > svg {
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--card-accent);
}
.stat-tile span {
  min-width: 0;
}
.stat-tile small,
.stat-tile strong {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.stat-tile small {
  font-size: var(--paper-font-caption);
  opacity: 0.66;
}
.stat-tile strong {
  margin-top: 2px;
  font-size: var(--paper-font-label);
}
/* 秘法推演格：占属性行空位的可点击变体，tone-magic 呼情报栏推演配色 */
.stat-tile.is-thinking {
  --detail-tone: #7266b5;
  border-color: color-mix(in srgb, var(--detail-tone) 74%, var(--card-ink));
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition:
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
    background-color 140ms ease;
}
.stat-tile.is-thinking > svg,
.stat-tile.is-thinking small {
  color: var(--detail-tone);
}
.stat-tile.is-thinking.active {
  color: var(--card-accent-bright);
  background: #3a3026;
}
.stat-tile.is-thinking.active > svg,
.stat-tile.is-thinking.active small {
  color: var(--card-accent-bright);
}

.skill-section,
.detail-section {
  margin-top: 10px;
}
.skill-section > header,
.detail-section > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 5px;
  padding-bottom: 3px;
  border-bottom: 2px solid color-mix(in srgb, var(--card-ink) 58%, transparent);
  font-size: var(--paper-font-label);
  font-weight: 950;
}
.skill-section > header small,
.detail-section > header small {
  font-size: var(--paper-font-caption);
  opacity: 0.58;
}
.skill-slots {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 5px;
}
.skill-slots button {
  position: relative;
  min-width: 0;
  padding: 7px 4px 9px;
  border: 2px solid #392619;
  color: var(--card-ink);
  background: color-mix(in srgb, var(--card-paper-dark) 24%, var(--card-paper-light));
  box-shadow: 2px 2px 0 rgba(50, 28, 13, 0.28);
  cursor: pointer;
  transition:
    transform 140ms cubic-bezier(0.23, 1, 0.32, 1),
    background-color 140ms ease;
}
.skill-slots button:disabled {
  cursor: default;
}
.skill-slots button > svg {
  width: 18px;
  height: 18px;
  margin: 0 auto 3px;
  color: var(--card-accent);
}
.skill-slots button span {
  display: block;
  overflow: hidden;
  font-size: var(--paper-font-small);
  font-weight: 900;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skill-slots button i {
  position: absolute;
  right: 3px;
  bottom: 3px;
  left: 3px;
  height: 2px;
  background: #98703f;
}
.skill-slots button.status-completed i {
  background: #598458;
}
.skill-slots button.status-error i,
.skill-slots button.status-rejected i {
  background: #a6463d;
}
.skill-slots button.status-pending i,
.skill-slots button.status-accepted i {
  background: #d6a440;
}
.skill-slots button.active {
  color: var(--card-accent-bright);
  background: #3d3025;
  box-shadow:
    0 0 0 2px var(--card-accent),
    3px 3px 0 rgba(50, 28, 13, 0.36);
}

.detail-grid {
  display: grid;
  gap: 5px;
}
/* 情报栏正文专栏：全文 markdown 内联渲染（复用侧边卡的墨色变量与字号修正） */
.inline-content {
  --ink: #302010;
  --accent: #704897;
  --border-strong: var(--card-accent);
  padding: 8px;
  border: 3px double color-mix(in srgb, var(--card-ink) 76%, var(--card-accent));
  background: color-mix(in srgb, var(--card-paper-light) 72%, transparent);
  box-shadow: 3px 3px 0 color-mix(in srgb, var(--card-paper-dark) 45%, transparent);
  overflow-wrap: anywhere;
  font-size: var(--paper-font-body);
  line-height: 1.55;
  content-visibility: auto;
  contain-intrinsic-size: auto 320px;

  .md-content();

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4),
  :deep(h5),
  :deep(h6) {
    font-size: 15px;
  }
  :deep(code),
  :deep(pre code) {
    font-size: var(--paper-font-label);
  }
  :deep(table) {
    font-size: var(--paper-font-small);
  }
}
.detail-tile {
  display: grid;
  grid-template-columns: 29px minmax(0, 1fr) 12px;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 48px;
  padding: 6px 7px;
  border: 2px solid color-mix(in srgb, var(--card-ink) 72%, var(--card-accent));
  color: var(--card-ink);
  background: color-mix(in srgb, var(--card-paper-light) 78%, transparent);
  box-shadow: 2px 2px 0 color-mix(in srgb, var(--card-paper-dark) 42%, transparent);
  text-align: left;
  cursor: pointer;
  transition:
    transform 160ms cubic-bezier(0.23, 1, 0.32, 1),
    background-color 160ms ease;
}
.detail-tile.tone-magic {
  --detail-tone: #7266b5;
}
.detail-tile.tone-success {
  --detail-tone: #5f925d;
}
.detail-tile.tone-warning {
  --detail-tone: #aa4d42;
}
.detail-icon {
  display: grid;
  place-items: center;
  width: 27px;
  height: 27px;
  color: var(--detail-tone, var(--card-accent));
  background: #33271d;
  font-size: 17px;
}
.detail-copy {
  min-width: 0;
}
.detail-copy strong,
.detail-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.detail-copy strong {
  font-size: var(--paper-font-label);
}
.detail-copy small {
  margin-top: 3px;
  font-size: var(--paper-font-caption);
  opacity: 0.64;
}
.detail-arrow {
  font:
    900 19px/1 ui-monospace,
    monospace;
}
.detail-tile.active {
  color: var(--card-accent-bright);
  background: #3a3026;
  transform: translateX(3px);
}
.detail-tile.pinned::after {
  content: '';
  position: absolute;
}

.process-stage {
  margin-top: 10px;
}
.process-stage > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 5px;
  padding-bottom: 3px;
  border-bottom: 2px solid color-mix(in srgb, var(--card-ink) 58%, transparent);
  font-size: var(--paper-font-label);
  font-weight: 950;
}
.process-stage > header small {
  font-size: var(--paper-font-caption);
  opacity: 0.58;
}
.process-stage-list {
  display: grid;
  gap: 0;
  margin: 0;
  padding: 0;
  list-style: none;
}
.process-step {
  position: relative;
  display: grid;
  grid-template-columns: 28px minmax(0, 1fr);
  min-width: 0;
}
.process-step-rail {
  position: relative;
  display: flex;
  justify-content: center;
}
.process-step-rail::after {
  content: '';
  position: absolute;
  z-index: 0;
  top: 25px;
  bottom: -1px;
  width: 3px;
  background: repeating-linear-gradient(
    180deg,
    color-mix(in srgb, var(--card-accent) 82%, var(--card-ink)) 0 5px,
    transparent 5px 8px
  );
}
.process-step:last-child .process-step-rail::after {
  display: none;
}
.process-step-rail i {
  position: relative;
  z-index: 1;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  margin-top: 9px;
  border: 2px solid var(--card-ink);
  border-radius: 50%;
  color: #f1dfaa;
  background: var(--card-accent);
  font-size: var(--paper-font-caption);
  font-style: normal;
  font-weight: 950;
}
.process-step-trigger {
  display: grid;
  grid-template-columns: 29px minmax(0, 1fr) auto 12px;
  align-items: center;
  gap: 6px;
  min-width: 0;
  min-height: 56px;
  padding: 7px 5px 9px;
  border: 0;
  border-bottom: 1px solid color-mix(in srgb, var(--card-ink) 26%, transparent);
  color: var(--card-ink);
  background: transparent;
  text-align: left;
  cursor: pointer;
  transition:
    transform 150ms cubic-bezier(0.23, 1, 0.32, 1),
    color 150ms ease,
    background-color 150ms ease;
}
.process-step-icon {
  display: grid;
  place-items: center;
  width: 27px;
  height: 27px;
  color: var(--card-accent);
  background: #33271d;
  font-size: 17px;
}
.process-step-copy {
  min-width: 0;
}
.process-step-copy small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.process-name-viewport {
  display: block;
  min-width: 0;
  overflow: hidden;
}
.process-name-track {
  display: flex;
  width: max-content;
  min-width: 100%;
}
.process-name-track strong {
  flex: 0 0 auto;
  padding-right: 22px;
  font-size: var(--paper-font-label);
}
.process-name-track strong::after {
  content: '◆';
  margin-left: 20px;
  color: var(--card-accent);
  font-size: 8px;
}
.process-name-track strong:last-child::after {
  content: '';
}
.process-name-viewport.is-looping .process-name-track {
  animation: process-name-loop 11s linear infinite;
  animation-play-state: paused;
}
.process-step-trigger:hover .process-name-track,
.process-step-trigger:focus-visible .process-name-track {
  animation-play-state: running;
}
.process-step-copy small {
  margin-top: 3px;
  font-size: var(--paper-font-caption);
  opacity: 0.64;
}
.process-step-status {
  padding: 2px 5px;
  border: 1px solid color-mix(in srgb, var(--card-accent) 65%, transparent);
  font-size: var(--paper-font-caption);
  font-weight: 900;
  white-space: nowrap;
}
.process-step.active .process-step-trigger {
  color: var(--card-accent-bright);
  background: #3a3026;
  transform: translateX(2px);
}
.process-step.active .process-step-rail i {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--card-accent) 34%, transparent);
}
@keyframes process-name-loop {
  to {
    transform: translateX(-50%);
  }
}

.paper-member-card {
  position: absolute;
  z-index: 21;
  top: clamp(8%, var(--stage-anchor-y), 74%);
  left: 58%;
  width: min(84%, 390px);
  height: 82%;
  min-width: 300px;
  transform: translateY(-28%);
  transform-origin: left center;
}

.game-card-footer {
  display: flex;
  align-items: center;
  min-height: 43px;
  gap: 6px;
  padding: 5px 11px;
  border-top: 3px solid #2d1d11;
  background: color-mix(in srgb, var(--card-paper-dark) 58%, var(--card-paper));
}
.termination-seal {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  overflow: hidden;
  color: #81392f;
  font-size: var(--paper-font-caption);
  font-weight: 900;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.termination-seal svg {
  width: 13px;
  height: 13px;
}
.branch-actions {
  display: flex;
  gap: 5px;
  margin-left: auto;
}
.branch-actions button,
.paper-side-card footer button {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  border: 2px solid #2d1c10;
  color: #f0d991;
  background: #493525;
  box-shadow: 2px 2px 0 rgba(30, 17, 8, 0.35);
  font-size: var(--paper-font-caption);
  font-weight: 900;
  cursor: pointer;
  transition: transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
}
.branch-actions svg,
.paper-side-card footer button svg {
  width: 12px;
  height: 12px;
}
.branch-actions button:disabled {
  opacity: 0.42;
  cursor: not-allowed;
}

.paper-side-card {
  --side-accent: var(--card-accent);
  position: absolute;
  z-index: 20;
  top: 9%;
  left: 58%;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  width: min(92%, 560px);
  height: 88%;
  min-width: 260px;
  overflow: hidden;
  border: 4px solid #26170d;
  color: #302010;
  background:
    repeating-linear-gradient(0deg, transparent 0 7px, rgba(70, 42, 19, 0.05) 7px 8px), #dfc790;
  box-shadow:
    0 0 0 2px var(--side-accent),
    7px 9px 0 rgba(23, 13, 7, 0.42),
    0 18px 42px rgba(20, 10, 4, 0.32);
  transform-origin: 12% 48%;
}
.paper-side-card.is-magic {
  --side-accent: #8479c7;
}
.paper-side-card.is-success {
  --side-accent: #6d9d64;
}
.paper-side-card.is-warning {
  --side-accent: #b25244;
}
.paper-side-card > header {
  display: grid;
  grid-template-columns: 33px minmax(0, 1fr) 24px;
  align-items: center;
  gap: 7px;
  padding: 7px;
  border-bottom: 3px solid #332014;
  background: color-mix(in srgb, var(--side-accent) 42%, #725337);
}
.paper-side-card > header > span {
  display: grid;
  place-items: center;
  width: 31px;
  height: 31px;
  color: #efd78f;
  background: #342318;
  font-size: 19px;
}
.paper-side-card > header small,
.paper-side-card > header strong {
  display: block;
}
.paper-side-card > header small {
  font-size: var(--paper-font-caption);
  letter-spacing: 0.12em;
  opacity: 0.66;
}
.paper-side-card > header strong {
  margin-top: 2px;
  font-size: 14px;
}
.paper-side-card > header button {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 2px solid #342116;
  color: #efdbad;
  background: #4a3324;
  font: 900 16px/1 monospace;
  cursor: pointer;
}
.side-card-body {
  min-height: 0;
  padding: 11px;
  overflow: auto;
  scrollbar-color: var(--side-accent) #6d4d30;
  scrollbar-width: thin;
  font-size: var(--paper-font-body);
  line-height: 1.55;
}
.side-card-body .markdown-body {
  --ink: #302010;
  --accent: #704897;
  --border-strong: var(--side-accent);
  .md-content();

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4),
  :deep(h5),
  :deep(h6) {
    font-size: 15px;
  }
  :deep(code),
  :deep(pre code) {
    font-size: var(--paper-font-label);
  }
  :deep(table) {
    font-size: var(--paper-font-small);
  }
}
.side-card-body :deep(.tool-field > dt) {
  font-size: var(--paper-font-small);
}
.side-card-body :deep(.tool-field > dt small) {
  font-size: var(--paper-font-caption);
}
.side-card-body :deep(.tool-field > dd) {
  font-size: var(--paper-font-label);
}
.field-list {
  display: grid;
  gap: 5px;
  margin: 0;
}
.field-row {
  display: grid;
  grid-template-columns: 74px minmax(0, 1fr);
  gap: 6px;
  align-items: start;
  padding: 5px 6px;
  border: 1px solid #594025;
  background: #f3e3ba;
}
.field-row dt {
  font-weight: 950;
  color: #704897;
  overflow-wrap: anywhere;
}
.field-row dd {
  margin: 0;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  font:
    var(--paper-font-label) / 1.5 ui-monospace,
    monospace;
  color: #302010;
}
.field-row.is-path dt,
.field-row.is-url dt,
.field-row.is-command dt {
  color: #86602a;
}
.side-card-body pre {
  margin: 0;
  padding: 9px;
  overflow: auto;
  border: 2px solid #594025;
  color: #f0deb5;
  background: #2d271f;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font:
    var(--paper-font-label) / 1.55 ui-monospace,
    monospace;
}
.plain-detail {
  margin: 0;
  white-space: pre-wrap;
}
.paper-side-card > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-top: 3px solid #332014;
  background: #8a6845;
}
.paper-side-card > footer > span {
  font:
    700 var(--paper-font-caption) / 1 ui-monospace,
    monospace;
  opacity: 0.7;
}

.side-card-enter-active,
.side-card-leave-active {
  transition:
    opacity 200ms cubic-bezier(0.23, 1, 0.32, 1),
    transform 240ms cubic-bezier(0.23, 1, 0.32, 1);
}
.side-card-enter-from,
.side-card-leave-to {
  opacity: 0;
  transform: translate3d(-16px, 5px, 0) scale(0.96);
}

.pixel-spark-field {
  position: absolute;
  z-index: 12;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.pixel-spark-field i {
  position: absolute;
  width: 3px;
  height: 3px;
  background: var(--card-accent-bright);
  opacity: 0;
  animation: paper-spark 520ms steps(4, end) both;
}
.spark-1 {
  top: 12%;
  left: 9%;
  animation-delay: 180ms !important;
}
.spark-2 {
  top: 24%;
  right: 8%;
  animation-delay: 220ms !important;
}
.spark-3 {
  top: 47%;
  left: 5%;
  animation-delay: 260ms !important;
}
.spark-4 {
  top: 65%;
  right: 6%;
  animation-delay: 300ms !important;
}
.spark-5 {
  top: 79%;
  left: 12%;
  animation-delay: 340ms !important;
}
.spark-6 {
  top: 16%;
  left: 62%;
  animation-delay: 380ms !important;
}
.spark-7 {
  top: 88%;
  right: 20%;
  animation-delay: 420ms !important;
}
@keyframes paper-spark {
  0%,
  100% {
    opacity: 0;
    transform: translateY(0) scale(1);
  }
  35%,
  65% {
    opacity: 0.9;
    transform: translateY(-5px) scale(1.8);
  }
}

.game-card-header,
.status-ribbon,
.quest-summary,
.stat-grid,
.skill-section,
.detail-section,
.game-card-footer {
  animation: card-block-enter 220ms cubic-bezier(0.23, 1, 0.32, 1) both;
}
.status-ribbon {
  animation-delay: 40ms;
}
.quest-summary {
  animation-delay: 80ms;
}
.stat-grid {
  animation-delay: 110ms;
}
.skill-section {
  animation-delay: 130ms;
}
.detail-section {
  animation-delay: 160ms;
}
.game-card-footer {
  animation-delay: 180ms;
}
@keyframes card-block-enter {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}

.paper-game-card.is-quiet-motion {
  .pixel-spark-field {
    display: none;
  }
  .game-card-header,
  .status-ribbon,
  .quest-summary,
  .stat-grid,
  .skill-section,
  .detail-section,
  .game-card-footer {
    animation: none;
  }
}
@keyframes quiet-card-enter {
  from {
    opacity: 0;
  }
}

@media (hover: hover) and (pointer: fine) {
  .detail-tile:hover {
    transform: translateX(3px);
    background: color-mix(in srgb, var(--card-paper-light) 60%, white);
  }
  .detail-tile.active:hover {
    background: #3a3026;
  }
  .stat-tile.is-thinking:hover {
    transform: translateX(3px);
    background: color-mix(in srgb, var(--card-paper-light) 60%, white);
  }
  .stat-tile.is-thinking.active:hover {
    background: #3a3026;
  }
  .skill-slots button:hover,
  .branch-actions button:not(:disabled):hover,
  .paper-side-card footer button:hover {
    transform: translateY(-2px);
  }
}
.detail-tile:active,
.stat-tile.is-thinking:active,
.skill-slots button:active,
.branch-actions button:not(:disabled):active,
.paper-side-card footer button:active {
  transform: translateY(1px) scale(0.98);
}
button:focus-visible {
  outline: 3px solid #f2cf67;
  outline-offset: 2px;
}

@media (max-width: 900px) {
  .paper-side-card {
    top: 7%;
    left: 7%;
    width: 86%;
    height: 86%;
    min-width: 0;
  }
  .detail-section > header small {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .pixel-spark-field {
    display: none;
  }
  .process-name-viewport.is-looping .process-name-track {
    animation: none;
  }
  .side-card-enter-active,
  .side-card-leave-active {
    transition: opacity 100ms linear;
  }
  .side-card-enter-from,
  .side-card-leave-to {
    opacity: 0;
    transform: none;
  }
  .detail-tile,
  .stat-tile.is-thinking,
  .skill-slots button,
  .branch-actions button,
  .paper-side-card footer button {
    transition-duration: 0ms;
  }
  .game-card-header,
  .status-ribbon,
  .quest-summary,
  .stat-grid,
  .skill-section,
  .detail-section,
  .game-card-footer {
    animation: none;
  }
}
</style>
