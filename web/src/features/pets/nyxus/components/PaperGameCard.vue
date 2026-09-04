<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRenderedMarkdown } from '@/composables/useRenderedMarkdown'
import type { ExecutionNode } from '../graph/executionGraph'
import type {
  PaperDetailBlock,
  PaperGameCardModel,
  PaperProcessStage,
} from '../paper/paperCardModel'
import { buildPaperGameCard } from '../paper/paperCardModel'
import PaperPixelIcon from './PaperPixelIcon.vue'
import ToolFieldTree from './ToolFieldTree.vue'

const props = defineProps<{
  model: PaperGameCardModel
  maxHeight: number
  quietMotion?: boolean
  detailBranchAvailable?: boolean
  detailBranchUnavailableReason?: string
  node?: ExecutionNode
  foldNode?: ExecutionNode
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

const isAdventurer = computed(() => props.model.kind === 'adventurer')
const inlineMessageDetail = computed(() =>
  isAdventurer.value ? props.model.details.find((detail) => detail.kind === 'content') : undefined,
)
const inlineMessageSource = computed(() => inlineMessageDetail.value?.content ?? '')
const { html: renderedInlineMessage } = useRenderedMarkdown(inlineMessageSource, { mode: 'full' })
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
const { html: renderedInlineContent } = useRenderedMarkdown(inlineContentSource, { mode: 'full' })
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
const detailMarkdownSource = computed(() => {
  const detail = activeDetail.value
  return detail?.format === 'markdown' ? detail.content : ''
})
const { html: renderedDetail } = useRenderedMarkdown(detailMarkdownSource, { mode: 'full' })

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
  window.removeEventListener('pointerdown', onWindowPointerDown)
  window.removeEventListener('keydown', onWindowKeydown)
})

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '-')
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
        'is-error-group': model.containsHiddenError,
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
          :detail-branch-available="detailBranchAvailable"
          :detail-branch-unavailable-reason="detailBranchUnavailableReason"
          @select-call="selectStageCall(activeStage.id, $event)"
          @branch="emit('branch', $event)"
        />
      </div>
    </Transition>
  </div>
</template>

<style scoped lang="less" src="./PaperGameCard.styles.less"></style>
