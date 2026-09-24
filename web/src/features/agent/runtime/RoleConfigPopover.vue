<script setup lang="ts">
/**
 * RoleConfigPopover：单角色编制配置卡（el-popover 内部内容）。
 * 从 AgentDialog 拆出，负责 brain/senseGroup 选择 + 资料卡展示。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { gsap } from 'gsap'
import { useMotionTier } from '@/composables/useMotionTier'
import { LLM_PROTOCOL_CATALOG, type LlmProtocol } from '@chery/protocol'
import {
  agentApi,
  type BrainConfigDto,
  type BrainInfo,
  type ConfigDto,
  type RuntimeSelection,
  type SenseGroupOption,
  type SenseToolInfo,
  type ThinkingLevel,
} from '@/application/backend/public'

const props = withDefaults(
  defineProps<{
    role: string
    selection: RuntimeSelection
    brains: BrainInfo[]
    senseGroups: readonly SenseGroupOption[]
    config: ConfigDto | null
    senseTools: SenseToolInfo[]
    isPrimary: boolean
    primaryRole: string
    roleUsage?: { used: number; total: number; usage: number } | null
    /** 工作台堆叠卡把角色名移到整组卡片外框时隐藏卡内标题。 */
    showRoleName?: boolean
    /** 工作台堆叠卡专用：显示思考等级悬停入口 + 泰拉瑞亚风切换（仅该场景开启）。 */
    showThinkingControl?: boolean
    /** v1.0 只读模式：仅展示资料卡、隐藏大脑/器官组选择区（workbench rail 角色 popout 用；
     *  发送消息角色卡不传该 prop，保持可操作）。 */
    readonly?: boolean
  }>(),
  { readonly: false, showRoleName: true, showThinkingControl: false },
)

const emit = defineEmits<{
  (e: 'update:selection', val: RuntimeSelection): void
}>()

// local computed for v-model:selection — two-way binding via getter/setter
const localSelection = computed({
  get: () => props.selection,
  set: (val) => emit('update:selection', val),
})

function brainInfo(name: string): BrainInfo | undefined {
  return props.brains.find((brain) => brain.name === name)
}

function brainConfig(name: string) {
  return props.config?.llm.brain[name]
}

/** 思考档位 → 显示文字（资料卡 💭 tooltip 用）。
 *  档位值来自 `.chery/model-catalog.yaml` 的 wire.thinking[].display，是开放字符串
 *  （如 DeepSeek 的 `max`）。除固定档位外补一批常见档位，保证任意返回值都有中文名；
 *  仍未命中的走调用处兜底（原样显示）。
 *  注意：档位可能同时出现 xhigh 与 max（如 gpt-6 目录 [.., xhigh, max]），
 *  两者必须用不同中文名，避免切换面板出现两个「最高」。 */
const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: '关闭',
  on: '开',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '超高',
  // 目录 wire 自定义档位（如 DeepSeek 的 max）与常见档位安全映射
  max: '最高',
  min: '最低',
  none: '无',
  auto: '自动',
  adaptive: '自适应',
  balanced: '均衡',
  standard: '标准',
  moderate: '适中',
  minimal: '极少',
  deep: '深度',
  extreme: '极限',
  ultra: '极致',
  turbo: '极速',
  full: '全力',
  always: '始终',
  verbose: '详细',
}

/** 返回思考档位中文；off / 无配置 → null（不显示 💭）。 */
function thinkingLabel(cfg: BrainConfigDto | undefined): string | null {
  const level = cfg?.thinking ?? 'off'
  return level === 'off' ? null : (THINKING_LABEL[level] ?? null)
}

function supportsTools(brainName: string): boolean {
  return brainConfig(brainName)?.capabilities?.toolCall !== false
}

function selectBrain(selection: RuntimeSelection, brain: string): void {
  selection.brain = brain
  if (!supportsTools(brain)) {
    selection.senseGroup = ''
    selection.mcpServers = []
  } else if (!selection.senseGroup) {
    selection.senseGroup =
      props.senseGroups.find((g) => g.default)?.name ?? props.senseGroups[0]?.name ?? ''
  }
}

function senseEntries(group: string): string[] {
  return props.config?.sense_groups?.[group] ?? []
}

function senseName(entry: string): string {
  return entry.split(':')[0] ?? entry
}

function senseTool(entry: string): SenseToolInfo | undefined {
  return props.senseTools.find((tool) => tool.name === senseName(entry))
}

function formatContextLimit(limit: number | undefined): string {
  if (limit === undefined) return '—'
  if (limit >= 1000) return `${Math.round(limit / 1000)}k`
  return String(limit)
}

function formatTokens(value: number): string {
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

/** API 协议标识 → 中文/官方标签（胶囊 hover 详情用）。 */
function protocolLabel(protocol: LlmProtocol | undefined): string {
  if (!protocol) return '—'
  return LLM_PROTOCOL_CATALOG.find((entry) => entry.id === protocol)?.label ?? protocol
}

/** 器官组内单个能力入口的 hover 说明：工具 label · description。 */
function senseToolTitle(entry: string): string {
  const tool = senseTool(entry)
  if (!tool) return senseName(entry)
  return `${tool.label} · ${tool.description}`
}

/** 当前角色在 config.roles 中的默认 brain / senseGroup（无配置 → 空串，不标 ★）。 */
const roleDefault = computed<{ brain: string; senseGroup: string }>(() => {
  const cfg = props.config?.roles?.[props.role]
  return {
    brain: cfg?.brain ?? '',
    senseGroup: cfg?.senseGroup ?? '',
  }
})

// ── ① 名称/模型 大小字互切（大脑选择区 choice-slot） ────────────
/** true=名称大字、模型小字；false=模型大字、名称小字。大脑区块标题 ⇄ 一键切换。 */
const nameIsBig = ref(true)

// ── ② 思考等级：悬停入口 + 泰拉瑞亚风切换（仅工作台堆叠卡） ──────
const thinkingOpen = ref(false)
let thinkingAnimationTarget: ThinkingLevel | null = null
/** 当前生效的思考档位：临时覆盖优先，缺省用大脑配置默认档位。 */
const effectiveThinking = computed<ThinkingLevel>(() => {
  const sel = localSelection.value
  return sel.thinking ?? brainConfig(sel.brain)?.thinking ?? 'off'
})
/** 当前大脑的模型目录可用档位（getModelRecommendation，按选中大脑异步拉取）。 */
const thinkingLevels = ref<readonly ThinkingLevel[]>([])
/** 无可用档位（模型未匹配目录规则）→ 锁定，仅展示当前档位。 */
const thinkingLevelsLocked = computed(() => thinkingLevels.value.length === 0)
/** 切换面板的档位列表：目录可用档位 + 当前生效档位（若不在目录里则追加，保证高亮块始终落在真实档位上）。 */
const displayThinkingLevels = computed<readonly ThinkingLevel[]>(() => {
  if (thinkingLevelsLocked.value) return [effectiveThinking.value]
  const list = [...thinkingLevels.value]
  if (!list.includes(effectiveThinking.value)) list.push(effectiveThinking.value)
  return list
})
const thinkingEntryText = computed(() => {
  const lvl = effectiveThinking.value
  return `思考 · ${THINKING_LABEL[lvl] ?? lvl}`
})
/** 选中档位 → 作为本次会话该角色的临时覆盖写入 selection（跟随现有编制同步链路）。 */
function setThinking(level: ThinkingLevel): void {
  if (level === effectiveThinking.value) return
  thinkingAnimationTarget = level
  localSelection.value = { ...localSelection.value, thinking: level }
}
/** 大脑变化 → 重新拉取可用档位；原覆盖不在新模型可用档位里则清除（回落大脑配置默认）。 */
watch(
  () => {
    const sel = localSelection.value
    const cfg = brainConfig(sel.brain)
    // 用原语作 watch 键（而非数组）：Vue 对 watch getter 返回值做引用比较，
    // selection 每次更新（含「仅改思考档位」的临时覆盖）都会让本 getter 重新执行并生成新数组引用，
    // 导致本 watch 误触发 → thinkingLevels 被清空重拉 → 切换面板收缩又扩展、色块闪到首位再跳回。
    // 原语键只在 brain/model/provider/protocol 真正变化时才触发。
    return `${sel.brain}\u0000${cfg?.model ?? ''}\u0000${cfg?.provider ?? ''}\u0000${cfg?.protocol ?? ''}`
  },
  async (key) => {
    const [brainName = ''] = key.split('\u0000')
    thinkingLevels.value = []
    const cfg = brainConfig(brainName)
    if (!cfg?.model) return
    try {
      const res = await agentApi.getModelRecommendation(cfg.model, cfg.provider, cfg.protocol)
      thinkingLevels.value = res.thinkingLevels ?? []
    } catch {
      thinkingLevels.value = []
    }
    const override = localSelection.value.thinking
    if (
      override !== undefined &&
      thinkingLevels.value.length > 0 &&
      !thinkingLevels.value.includes(override)
    ) {
      localSelection.value = { ...localSelection.value, thinking: undefined }
    }
  },
  { immediate: true },
)

// ── 思考等级切换面板：滑动高亮 switch（对齐标题栏 树/对话/精简 切换效果） ──
// 独立金色色块左右平移 + Q弹（弹性回弹 + 横向挤压-回弹），文字变色由遮罩随色块矩形裁切完成。
const thinkingSwitchEl = ref<HTMLDivElement | null>(null)
const thinkingSliderEl = ref<HTMLSpanElement | null>(null)
const thinkingMaskEl = ref<HTMLDivElement | null>(null)
const thinkingButtonEls: Array<HTMLButtonElement | null> = []
function setThinkingButtonEl(index: number, el: unknown): void {
  thinkingButtonEls[index] = (el as HTMLButtonElement | null) ?? null
}
/** 当前生效档位在档位列表中的下标；不在列表 → 0（锁定单档时列表只有当前档位）。 */
const activeThinkingIndex = computed(() => {
  const idx = displayThinkingLevels.value.indexOf(effectiveThinking.value)
  return idx < 0 ? 0 : idx
})

const { spec: thinkingMotionSpec } = useMotionTier()
// Q弹只在动效偏好 full 时启用；reduced 档瞬间落位。
// 刻意不依赖渲染质量档位（decoration）：色块是核心交互反馈，低渲染档下也必须能明显看到高亮在移动。
const thinkingCanAnimate = computed(() => thinkingMotionSpec.value.mode === 'full')

// 色块相对档位左右各留 2px，上下贴满整格高度（与标题栏 switch 同规）。
const THINKING_BLOCK_INSET = 2
const thinkingAnimState = { x: 0, width: 0, scaleX: 1 }
let thinkingCachedMaskW = 0
let thinkingSliderTimeline: gsap.core.Timeline | null = null
let thinkingPendingSync: number | null = null
let thinkingFirstSync = true

/** 把遮罩（反色文字层）裁到色块当前覆盖的矩形：被盖住的档位文字反色，未盖住保持基色。 */
function applyThinkingClip(left: number, width: number): void {
  const mask = thinkingMaskEl.value
  if (!mask || thinkingCachedMaskW <= 0) return
  const l = Math.max(0, Math.min(left, thinkingCachedMaskW))
  const r = Math.max(0, Math.min(thinkingCachedMaskW - left - width, thinkingCachedMaskW))
  mask.style.clipPath = `inset(0px ${r.toFixed(2)}px 0px ${l.toFixed(2)}px)`
}

/** 由 animState 一次性写出色块位置/形变（形变并入宽度、绕中心对称）与遮罩裁切。 */
function applyThinkingVisual(): void {
  const slider = thinkingSliderEl.value
  if (!slider) return
  const { x, width, scaleX } = thinkingAnimState
  const visualW = width * scaleX
  const visualLeft = x + (width - visualW) / 2
  gsap.set(slider, { x: visualLeft, width: visualW })
  applyThinkingClip(visualLeft, visualW)
}

/**
 * 把色块与遮罩放到当前生效档位。animate=true 走 Q弹；false 直接就位（首开/布局变化/精简动效档）。
 * 测量用 offsetLeft/offsetWidth（布局尺寸、规范明确忽略 CSS transform）而非 getBoundingClientRect：
 * 工作台打开动画会给面板临时加 scale，此时 rect 会把缩小后的宽度测进去导致色块偏短且不再自愈，
 * offset 系列不受缩放影响，任何时机测量都正确。
 */
function syncThinkingSlider(animate: boolean): void {
  const slider = thinkingSliderEl.value
  const mask = thinkingMaskEl.value
  if (!slider || !mask || thinkingButtonEls.length === 0) {
    scheduleThinkingSync(animate)
    return
  }
  const btn =
    thinkingButtonEls[activeThinkingIndex.value] ??
    thinkingButtonEls.find((b): b is HTMLButtonElement => b !== null) ??
    null
  if (!btn) {
    scheduleThinkingSync(animate)
    return
  }
  thinkingPendingSync = null
  thinkingCachedMaskW = mask.offsetWidth
  const x = btn.offsetLeft - mask.offsetLeft + THINKING_BLOCK_INSET
  const width = btn.offsetWidth - THINKING_BLOCK_INSET * 2

  thinkingSliderTimeline?.kill()
  thinkingSliderTimeline = null

  if (!animate || !thinkingCanAnimate.value) {
    thinkingAnimState.x = x
    thinkingAnimState.width = width
    thinkingAnimState.scaleX = 1
    applyThinkingVisual()
    return
  }
  // 位置移动用 power3.out（严格不过冲）：档位多达 6 个且等宽密集排列，elastic 回弹过冲会
  // 甩到目标档位之外的相邻/最高档，看起来像"先跳到最高再闪回"。Q弹保留 scaleX 横向挤压-回弹。
  thinkingSliderTimeline = gsap
    .timeline({ overwrite: 'auto', onUpdate: applyThinkingVisual })
    .to(thinkingAnimState, { x, duration: 0.6, ease: 'power3.out' }, 0)
    .fromTo(
      thinkingAnimState,
      { scaleX: 0.78 },
      { scaleX: 1.16, duration: 0.24, ease: 'power2.out' },
      0,
    )
    .to(thinkingAnimState, { scaleX: 1, duration: 0.4, ease: 'power2.out' }, '-=0.18')
}

function scheduleThinkingSync(animate: boolean): void {
  if (thinkingPendingSync != null) return
  thinkingPendingSync = requestAnimationFrame(() => {
    thinkingPendingSync = null
    syncThinkingSlider(animate)
  })
}

// 展开时直接就位；展开后的档位切换/大脑切换（可用档位变化）才播 Q弹。
watch(thinkingOpen, (open) => {
  if (!open) return
  thinkingFirstSync = true
  void nextTick(() => {
    syncThinkingSlider(false)
    thinkingFirstSync = false
  })
})
watch(activeThinkingIndex, () => {
  if (!thinkingOpen.value) return
  const shouldAnimate = thinkingAnimationTarget === effectiveThinking.value
  thinkingAnimationTarget = null
  void nextTick(() => {
    syncThinkingSlider(shouldAnimate && !thinkingFirstSync)
    thinkingFirstSync = false
  })
})

// 布局变化（档位增删 / 字号加载 / 容器尺寸变化）：色块无动画跟随新位置。
let thinkingResizeObserver: ResizeObserver | null = null
watch(
  thinkingSliderEl,
  (slider) => {
    thinkingResizeObserver?.disconnect()
    thinkingResizeObserver = null
    const el = slider?.parentElement
    if (!el) return
    thinkingResizeObserver = new ResizeObserver(() => syncThinkingSlider(false))
    thinkingResizeObserver.observe(el)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  thinkingSliderTimeline?.kill()
  thinkingSliderTimeline = null
  if (thinkingPendingSync != null) {
    cancelAnimationFrame(thinkingPendingSync)
    thinkingPendingSync = null
  }
  thinkingResizeObserver?.disconnect()
  thinkingResizeObserver = null
})
</script>

<template>
  <el-card
    shadow="never"
    class="role-card terraria-role-card"
    :class="{ 'is-readonly': readonly }"
    :aria-label="`${role} 的临时编制${readonly ? '（只读）' : ''}`"
  >
    <!-- 思考等级（仅工作台堆叠卡）：悬停浮现入口，点击展开泰拉瑞亚风切换；选中即本会话该角色生效。 -->
    <div v-if="showThinkingControl" class="thinking-control" :class="{ 'is-open': thinkingOpen }">
      <button
        type="button"
        class="thinking-entry"
        :class="{ open: thinkingOpen }"
        :aria-expanded="thinkingOpen"
        aria-label="调整思考等级"
        @click="thinkingOpen = !thinkingOpen"
      >
        <span class="thinking-entry-icon" aria-hidden="true">💭</span>
        <span class="thinking-entry-text">{{ thinkingEntryText }}</span>
        <span class="thinking-entry-caret" aria-hidden="true" :class="{ open: thinkingOpen }"
          >▾</span
        >
      </button>
      <Transition name="thinking-pop">
        <div
          v-if="thinkingOpen"
          class="thinking-switch"
          role="radiogroup"
          aria-label="思考等级切换"
        >
          <!-- 独立金色色块：唯一高亮载体，绝对定位 + 左右平移 + Q弹形变（同标题栏 树/对话/精简 switch） -->
          <span ref="thinkingSliderEl" class="thinking-switch-slider" aria-hidden="true" />
          <!-- 文字变色遮罩层：复制各档位文字（深色墨），随色块矩形裁切，被盖住的档位反色、其余保持基色 -->
          <div ref="thinkingMaskEl" class="thinking-switch-mask" aria-hidden="true">
            <div class="thinking-switch-track">
              <span
                v-for="level in displayThinkingLevels"
                :key="level"
                class="thinking-switch-hi"
                >{{ THINKING_LABEL[level] ?? level }}</span
              >
            </div>
          </div>
          <button
            v-for="(level, index) in displayThinkingLevels"
            :key="level"
            :ref="(el) => setThinkingButtonEl(index, el)"
            type="button"
            class="thinking-switch-option"
            :class="{ active: activeThinkingIndex === index }"
            :disabled="thinkingLevelsLocked"
            role="radio"
            :aria-checked="activeThinkingIndex === index"
            @click="setThinking(level)"
          >
            <!-- 文字单独一层，永远浮在色块之上：色块滑过时标签始终可读 -->
            <span class="thinking-switch-copy">{{ THINKING_LABEL[level] ?? level }}</span>
          </button>
        </div>
      </Transition>
    </div>

    <div class="profile-hero">
      <el-avatar :size="52" class="profile-avatar">{{ role.slice(0, 1) }}</el-avatar>
      <div class="profile-identity">
        <strong v-if="showRoleName">{{ role }}</strong>
        <div class="profile-summary">
          <span class="identity-kind">{{ isPrimary ? '♛ 小组组长' : '✦ 小组成员' }}</span>
          <span v-if="readonly" class="identity-readonly" aria-label="只读">🔒 只读</span>
          <span class="brain-name">◈ {{ selection.brain || '未选择大脑' }}</span>
        </div>
        <div class="brain-facts" aria-label="当前大脑参数">
          <span class="brain-fact-text"
            ><b>模型</b>{{ brainConfig(selection.brain)?.model ?? '—' }}</span
          >
          <span class="brain-fact-text"
            ><b>上下文</b
            >{{
              formatContextLimit(
                brainInfo(selection.brain)?.contextLimit ??
                  brainConfig(selection.brain)?.contextLimit,
              )
            }}</span
          >
          <span v-if="roleUsage" class="brain-fact-text role-usage-fact">
            <b>已用</b>{{ formatTokens(roleUsage.used) }}/{{ formatTokens(roleUsage.total) }} ·
            {{ Math.round(roleUsage.usage * 100) }}%
          </span>
          <el-tooltip
            v-if="thinkingLabel(brainConfig(selection.brain))"
            :content="`思考（${thinkingLabel(brainConfig(selection.brain))}）`"
            placement="top"
          >
            <span class="brain-fact-icon">💭</span>
          </el-tooltip>
          <el-tooltip v-if="supportsTools(selection.brain)" content="工具调用" placement="top">
            <span class="brain-fact-icon">🔧</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.input?.image"
            content="模型支持图像输入"
            placement="top"
          >
            <span class="brain-fact-icon cap-input">🖼️</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.input?.video"
            content="模型支持视频输入"
            placement="top"
          >
            <span class="brain-fact-icon cap-input">🎞️</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.input?.audio"
            content="模型支持音频输入"
            placement="top"
          >
            <span class="brain-fact-icon cap-input">🔊</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.generate?.image"
            content="模型支持图像生成"
            placement="top"
          >
            <span class="brain-fact-icon cap-generate">🎨</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.generate?.video"
            content="模型支持视频生成"
            placement="top"
          >
            <span class="brain-fact-icon cap-generate">🎬</span>
          </el-tooltip>
          <el-tooltip
            v-if="brainConfig(selection.brain)?.capabilities?.generate?.audio"
            content="模型支持音频生成"
            placement="top"
          >
            <span class="brain-fact-icon cap-generate">🎵</span>
          </el-tooltip>
        </div>
        <div
          v-if="senseEntries(selection.senseGroup).length"
          class="profile-sense-icons"
          aria-label="已启用能力"
        >
          <el-tooltip
            v-for="entry in senseEntries(selection.senseGroup)"
            :key="entry"
            :content="`${senseTool(entry)?.label ?? senseName(entry)} · ${senseTool(entry)?.description ?? '未提供能力说明'}`"
            placement="top"
          >
            <span class="profile-sense-icon">{{ senseTool(entry)?.icon ?? '⚙' }}</span>
          </el-tooltip>
        </div>
      </div>
    </div>

    <div v-if="!readonly" class="profile-settings">
      <section class="profile-setting">
        <div class="setting-heading">
          <span class="setting-icon">◈</span>
          <span>大脑</span>
        </div>
        <button
          type="button"
          class="brain-swap-toggle"
          :aria-label="nameIsBig ? '把模型切换为大字显示' : '把名称切换为大字显示'"
          @click="nameIsBig = !nameIsBig"
        >
          <span aria-hidden="true">⇄</span>
        </button>
        <div class="choice-list" role="radiogroup" aria-label="选择模型">
          <span v-for="brain in brains" :key="brain.name" class="choice-slot">
            <el-tooltip
              placement="top"
              :show-after="150"
              :hide-after="0"
              popper-class="role-detail-popper"
            >
              <template #content>
                <div class="role-detail" aria-label="大脑详情">
                  <div class="role-detail-title">{{ brain.name }}</div>
                  <div class="role-detail-row">
                    <span class="role-detail-key">模型</span>
                    <span class="role-detail-value">{{
                      brainConfig(brain.name)?.model ?? '—'
                    }}</span>
                  </div>
                  <div class="role-detail-row">
                    <span class="role-detail-key">API 协议</span>
                    <span class="role-detail-value">{{
                      protocolLabel(brainConfig(brain.name)?.protocol)
                    }}</span>
                  </div>
                  <div class="role-detail-row">
                    <span class="role-detail-key">上下文限制</span>
                    <span class="role-detail-value">{{
                      formatContextLimit(
                        brainInfo(brain.name)?.contextLimit ??
                          brainConfig(brain.name)?.contextLimit,
                      )
                    }}</span>
                  </div>
                  <div class="role-detail-row">
                    <span class="role-detail-key">工具调用</span>
                    <span class="role-detail-value">{{
                      supportsTools(brain.name) ? '支持' : '不支持'
                    }}</span>
                  </div>
                  <div class="role-detail-row">
                    <span class="role-detail-key">深度思考</span>
                    <span class="role-detail-value">{{
                      thinkingLabel(brainConfig(brain.name)) ?? '关闭'
                    }}</span>
                  </div>
                </div>
              </template>
              <button
                type="button"
                class="choice-option"
                :class="{ selected: localSelection.brain === brain.name }"
                :aria-checked="localSelection.brain === brain.name"
                role="radio"
                @click="selectBrain(localSelection, brain.name)"
              >
                <span class="choice-name" :class="nameIsBig ? 'is-big' : 'is-small'">{{
                  brain.name
                }}</span>
                <span class="choice-model" :class="nameIsBig ? 'is-small' : 'is-big'">{{
                  brainConfig(brain.name)?.model ?? '—'
                }}</span>
                <span
                  v-if="brain.name === roleDefault.brain"
                  class="choice-default"
                  aria-label="默认"
                  >★</span
                >
              </button>
            </el-tooltip>
          </span>
        </div>
      </section>

      <section v-if="supportsTools(localSelection.brain)" class="profile-setting sense-setting">
        <div class="setting-heading">
          <span class="setting-icon">✦</span>
          <span>器官组</span>
        </div>
        <div class="choice-list" role="radiogroup" aria-label="选择器官组">
          <span v-for="group in senseGroups" :key="group.name" class="choice-slot">
            <el-tooltip
              placement="top"
              :show-after="150"
              :hide-after="0"
              popper-class="role-detail-popper"
            >
              <template #content>
                <div class="role-detail" aria-label="器官组详情">
                  <div class="role-detail-title">{{ group.name }}</div>
                  <div class="sense-detail-tools">
                    <span
                      v-for="entry in senseEntries(group.name)"
                      :key="entry"
                      class="sense-detail-tool"
                      :title="senseToolTitle(entry)"
                    >
                      {{ senseTool(entry)?.icon ?? '⚙' }}
                    </span>
                    <span v-if="!senseEntries(group.name).length" class="sense-detail-empty"
                      >无工具</span
                    >
                  </div>
                </div>
              </template>
              <button
                type="button"
                class="choice-option"
                :class="{ selected: localSelection.senseGroup === group.name }"
                :aria-checked="localSelection.senseGroup === group.name"
                role="radio"
                @click="localSelection.senseGroup = group.name"
              >
                <span class="choice-option-label">{{ group.name }}</span>
                <span
                  v-if="group.name === roleDefault.senseGroup"
                  class="choice-default"
                  aria-label="默认"
                  >★</span
                >
              </button>
            </el-tooltip>
          </span>
        </div>
      </section>
      <p v-else class="runtime-note">该模型不支持 Tool Call，仅可进行对话与已标记的媒体理解。</p>
    </div>
    <div v-if="!readonly" class="runtime-note">仅本次会话，服务重启后失效</div>
  </el-card>
</template>

<style scoped lang="less">
.role-card {
  width: 100%;
  overflow: hidden;
  border-color: color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 12px;
  background: var(--panel);

  :deep(.el-card__body) {
    display: grid;
    gap: 8px;
    padding: 0 12px 10px;
  }
}

.profile-hero {
  margin: 0 -12px;
  padding: 11px 12px 9px;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  background:
    linear-gradient(
      115deg,
      color-mix(in srgb, var(--accent) 20%, transparent),
      color-mix(in srgb, var(--accent) 4%, transparent)
    ),
    var(--surface);
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 14%, transparent);
}

.profile-avatar {
  flex: none;
  border: 2px solid rgba(255, 255, 255, 0.82);
  background: #d99717;
  color: #fff;
  font-size: 22px;
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(129, 88, 15, 0.2);
}

.profile-identity {
  min-width: 0;
  flex: 1;
  display: grid;
  gap: 4px;

  strong {
    overflow: hidden;
    color: var(--ink);
    font-size: 18px;
    line-height: 1.15;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.profile-summary {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 7px;
  color: color-mix(in srgb, var(--ink) 68%, transparent);
}

.identity-kind {
  color: var(--accent);
  font-weight: 600;
}
/* v1.0 只读标（workbench rail 角色 popout）：暖金小 chip，与 identity-kind 同排。 */
.identity-readonly {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
  border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--accent);
  font-size: 12px;
  line-height: 16px;
  font-weight: 600;
}
.brain-name {
  color: color-mix(in srgb, var(--ink) 72%, transparent);
}

.brain-facts {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 5px;
  color: color-mix(in srgb, var(--ink) 65%, transparent);
  font-size: 12px;

  .brain-fact-text {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  b {
    margin-right: 3px;
    color: color-mix(in srgb, var(--ink) 42%, transparent);
    font-weight: 600;
  }

  .brain-fact-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
    background: var(--surface-soft);
    font-size: 13px;
    line-height: 1;
    cursor: pointer;

    &.cap-input {
      border-color: rgba(59, 130, 246, 0.28);
      background: color-mix(in srgb, #3b82f6 14%, var(--surface));
    }

    &.cap-generate {
      border-color: rgba(234, 88, 12, 0.3);
      background: color-mix(in srgb, #ea580c 12%, var(--surface));
    }
  }
}

.profile-sense-icons {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
}

.profile-sense-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  background: var(--surface-soft);
  font-size: 13px;
  cursor: pointer;
}

.profile-settings {
  display: grid;
  grid-template-columns: 1fr; /* 两列改两行：大脑一块、器官组一块 */
  gap: 12px;
}

.profile-setting {
  position: relative;
  min-width: 0;
  margin-top: 9px; /* 标题骑跨上边框（中线与边框线对齐）所需的突出空间 */
  padding: 12px 10px 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 8px;
  background: transparent; /* 让卡片底（--panel）透出，标题盖边框线时与背景无缝 */
}

/* 块标题：盖住上边框线、居左但不盖左上角，标题中线与边框线对齐（legend 式） */
.setting-heading {
  position: absolute;
  top: 0;
  left: 12px; /* 避开左上角圆角 */
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  background: var(--panel); /* 盖住身后的边框线 */
  color: color-mix(in srgb, var(--ink) 68%, transparent);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.03em;
  white-space: nowrap;
}

.setting-icon {
  color: #d99717;
  font-size: 15px;
  line-height: 1;
}

.choice-list {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 6px;
}

.choice-slot {
  display: inline-block;
  flex: none;
  max-width: 100%;
}

/* 子项胶囊：始终全量显示（不依赖 hover 展开），胶囊内不换行 */
.choice-option {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 4.5%, transparent);
  color: color-mix(in srgb, var(--ink) 64%, transparent);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color 0.15s ease,
    border-color 0.15s ease,
    color 0.15s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--accent) 38%, transparent);
    background: var(--surface-hover);
    color: color-mix(in srgb, var(--ink) 82%, transparent);
  }

  &.selected {
    border-color: color-mix(in srgb, var(--accent) 40%, transparent);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--accent);
    font-weight: 400;

    &:hover {
      background: color-mix(in srgb, var(--accent) 15%, transparent);
    }
  }
}

.choice-option-label {
  min-width: 0;
  white-space: nowrap;
}

.choice-default {
  flex: none;
  color: #bd8215;
  font-size: 12px;
  line-height: 1;
  text-shadow: 0 1px 0 rgba(255, 255, 255, 0.65);
}

.runtime-note {
  color: color-mix(in srgb, var(--ink) 46%, transparent);
  font-size: 12px;
  line-height: 1.2;
  text-align: right;
}

/* Terraria-inspired identity card: a dark inventory panel with hard pixel edges. */
.terraria-role-card {
  --terraria-ink: #f1e4c2;
  --terraria-muted: #b9aa87;
  --terraria-panel: #29231d;
  --terraria-panel-deep: #171411;
  --terraria-edge: #8b6a3e;
  --terraria-edge-dark: #4b3825;
  --terraria-gold: #e4b955;
  --terraria-blue: #76b8d2;
  --terraria-green: #9bc878;
  --terraria-red: #d9785d;

  position: relative;
  border: 3px solid var(--terraria-edge);
  border-radius: 0;
  background: var(--terraria-panel-deep);
  box-shadow:
    0 0 0 2px #0c0b0a,
    inset 0 0 0 1px var(--terraria-edge-dark),
    5px 5px 0 color-mix(in srgb, #000 70%, transparent);
  color: var(--terraria-ink);

  &::before,
  &::after {
    position: absolute;
    z-index: 2;
    width: 7px;
    height: 7px;
    background: var(--terraria-gold);
    content: '';
  }

  &::before {
    top: -3px;
    left: 18px;
  }

  &::after {
    right: 18px;
    bottom: -3px;
  }

  :deep(.el-card__body) {
    gap: 12px;
    padding: 0 14px 13px;
  }

  .profile-hero {
    position: relative;
    margin: 0 -14px;
    padding: 15px 14px 13px;
    border-bottom: 3px solid var(--terraria-edge);
    background: repeating-linear-gradient(
      0deg,
      color-mix(in srgb, var(--terraria-panel) 92%, #000),
      color-mix(in srgb, var(--terraria-panel) 92%, #000) 3px,
      color-mix(in srgb, var(--terraria-panel-deep) 92%, #000) 3px,
      color-mix(in srgb, var(--terraria-panel-deep) 92%, #000) 6px
    );
  }

  .profile-avatar {
    width: 58px;
    height: 58px;
    border: 3px solid var(--terraria-gold);
    border-radius: 0;
    background: var(--terraria-blue);
    box-shadow:
      3px 3px 0 #0c0b0a,
      inset 0 0 0 3px color-mix(in srgb, #fff 24%, transparent);
    color: #11100d;
    font-size: 25px;
    font-weight: 700;
  }

  .profile-identity {
    gap: 6px;

    strong {
      color: var(--terraria-ink);
      font-size: 21px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-shadow: 2px 2px 0 #0c0b0a;
    }
  }

  .profile-summary {
    gap: 4px 9px;
    color: var(--terraria-muted);
    font-size: 13px;
  }

  .identity-kind {
    color: var(--terraria-gold);
    font-weight: 700;
    text-transform: uppercase;
  }

  .identity-readonly {
    padding: 1px 6px;
    border: 1px solid var(--terraria-edge);
    border-radius: 0;
    background: var(--terraria-panel-deep);
    color: var(--terraria-muted);
    font-weight: 400;
  }

  .brain-name {
    color: var(--terraria-blue);
    font-weight: 700;
  }

  .brain-facts {
    gap: 5px 8px;
    color: var(--terraria-muted);

    b {
      color: var(--terraria-gold);
      font-weight: 400;
      text-transform: uppercase;
    }

    .brain-fact-icon {
      width: 20px;
      height: 20px;
      border: 1px solid var(--terraria-edge);
      border-radius: 0;
      background: var(--terraria-panel-deep);
    }

    .cap-input,
    .cap-generate {
      border-color: var(--terraria-edge);
      background: var(--terraria-panel-deep);
    }
  }

  .role-usage-fact {
    color: var(--terraria-green);
  }

  .profile-sense-icons {
    gap: 4px;
  }

  .profile-sense-icon {
    width: 22px;
    height: 22px;
    border: 1px solid var(--terraria-edge);
    border-radius: 0;
    background: var(--terraria-panel);
  }

  .profile-setting {
    margin-top: 11px;
    padding: 15px 11px 10px;
    border: 2px solid var(--terraria-edge-dark);
    border-radius: 0;
    background: var(--terraria-panel);
  }

  .setting-heading {
    left: 10px;
    padding: 1px 7px;
    border: 1px solid var(--terraria-edge);
    border-radius: 0;
    background: var(--terraria-panel-deep);
    color: var(--terraria-gold);
    font-weight: 700;
    letter-spacing: 0.05em;
  }

  .setting-icon {
    color: var(--terraria-gold);
  }

  .choice-list {
    gap: 7px;
  }

  .choice-option {
    min-height: 34px;
    padding: 5px 10px;
    border: 2px solid var(--terraria-edge-dark);
    border-radius: 0;
    background: var(--terraria-panel-deep);
    color: var(--terraria-muted);
    font-size: 13px;
    font-weight: 700;
    box-shadow: 2px 2px 0 #0c0b0a;

    &:hover {
      border-color: var(--terraria-gold);
      background: color-mix(in srgb, var(--terraria-panel) 85%, var(--terraria-gold));
      color: var(--terraria-ink);
    }

    &.selected {
      border-color: var(--terraria-blue);
      background: color-mix(in srgb, var(--terraria-blue) 22%, var(--terraria-panel-deep));
      color: var(--terraria-ink);
      box-shadow:
        2px 2px 0 #0c0b0a,
        inset 0 0 0 1px var(--terraria-blue);
    }
  }

  .choice-default {
    color: var(--terraria-gold);
    text-shadow: none;
  }

  .runtime-note {
    color: var(--terraria-muted);
    text-align: left;
  }
}

/* ── ① 名称/模型 大小字互切（大脑选择区 choice-slot） ─────────────
   每个大脑按钮内「名称 + 模型」同排展示，切换时一个变大一个变小
   （像气球通气：同刻互偿），字号过渡带轻微过冲回弹；不做气球/连线视觉。
   大脑区块右上角的 ⇄ 按钮（与「大脑」标题同骑上边框线、中线对齐）一键切换整组。 */
.brain-swap-toggle {
  position: absolute;
  top: 0;
  right: 12px;
  transform: translateY(-50%); /* 与「大脑」标题一样骑跨上边框线、中线对齐 */
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: 2px solid var(--terraria-edge-dark);
  border-radius: 0;
  background: var(--terraria-panel-deep);
  color: var(--terraria-muted);
  font-size: 12px;
  line-height: 1;
  box-shadow: 2px 2px 0 #0c0b0a;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;

  &:hover {
    border-color: var(--terraria-gold);
    color: var(--terraria-gold);
  }
}

.choice-name,
.choice-model {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition:
    font-size 0.38s cubic-bezier(0.34, 1.3, 0.64, 1),
    line-height 0.38s cubic-bezier(0.34, 1.3, 0.64, 1),
    color 0.25s ease,
    text-shadow 0.25s ease;

  &.is-big {
    font-size: 18px;
    line-height: 1.15;
    color: var(--terraria-ink);
    font-weight: 700;
    letter-spacing: 0.02em;
    text-shadow: 2px 2px 0 #0c0b0a;
  }

  &.is-small {
    font-size: 9px; /* 超小字：用户明确要求 8-9px 级别 */
    line-height: 1.15;
    color: var(--terraria-muted);
    font-weight: 400;
    letter-spacing: 0.05em;
    text-shadow: 1px 1px 0 #0c0b0a;
  }
}

/* ── ② 思考等级：悬停入口 + 泰拉瑞亚风切换（仅工作台堆叠卡） ──────
   悬停卡片时右上角浮现入口；点击展开档位切换面板；选中档位即本会话生效。 */
.thinking-control {
  position: absolute;
  z-index: 6;
  top: 10px;
  right: 12px;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}

.terraria-role-card:hover .thinking-control,
.thinking-control.is-open {
  opacity: 1;
  pointer-events: auto;
}

.thinking-entry {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border: 2px solid var(--terraria-edge-dark);
  border-radius: 0;
  background: var(--terraria-panel-deep);
  color: var(--terraria-muted);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  box-shadow: 2px 2px 0 #0c0b0a;
  cursor: pointer;
  transition: border-color 0.15s ease, color 0.15s ease;

  &:hover,
  &.open {
    border-color: var(--terraria-gold);
    color: var(--terraria-ink);
  }

  .thinking-entry-icon {
    font-size: 13px;
    line-height: 1;
  }

  .thinking-entry-caret {
    font-size: 10px;
    line-height: 1;
    transition: transform 0.15s ease;

    &.open {
      transform: rotate(180deg);
    }
  }
}

/* 滑动高亮 switch（对齐标题栏 树/对话/精简 切换效果）：
   独立金色色块左右平移 + Q弹（弹性回弹 + 横向挤压-回弹），
   文字变色由遮罩随色块矩形裁切完成，不改按钮字体颜色。 */
.thinking-switch {
  position: relative;
  display: inline-flex;
  flex-wrap: nowrap;
  padding: 2px;
  border: 2px solid var(--terraria-edge-dark);
  border-radius: 0;
  background: var(--terraria-panel-deep);
  box-shadow:
    3px 3px 0 #0c0b0a,
    inset 0 0 0 1px color-mix(in srgb, var(--terraria-edge) 40%, transparent);
}

/* 独立金色色块：绝对定位在容器内容盒，上下贴满整格高度，左右随档位各留 2px。
   高亮唯一载体——按钮自身不再加高亮背景，激活态由色块平移到位表达。 */
.thinking-switch-slider {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  z-index: 1;
  background: var(--terraria-gold);
  box-shadow:
    inset 0 0 0 2px color-mix(in srgb, #2b1c08 55%, transparent),
    inset 0 0 0 3px color-mix(in srgb, #fff 18%, transparent);
  pointer-events: none;
}

/* 高亮文字遮罩层：与色块同源定位（内容盒），把反色文字裁到色块矩形。
   色块平移/形变时 clip-path 逐帧跟随，被盖住的档位反色、未盖住保持基色。
   JS 未就位前默认裁空（右侧全收），避免闪出全量反色文字。 */
.thinking-switch-mask {
  position: absolute;
  top: 2px;
  left: 2px;
  right: 2px;
  bottom: 2px;
  z-index: 3;
  overflow: hidden;
  pointer-events: none;
  user-select: none;
  clip-path: inset(0 100% 0 0);
}

/* 反色文字轨道：布局与按钮行完全一致（同宽/同距/同字号），从内容盒左缘起排。
   必须用块级 flex（而非 inline-flex）：行内级元素会参与父容器行盒的基线对齐被压偏。 */
.thinking-switch-track {
  display: flex;
  height: 100%;
}

/* 反色文字副本：与按钮等宽等距，仅颜色为金色色块专用深色墨。 */
.thinking-switch-hi {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 48px;
  flex: 0 0 48px;
  padding: 0 4px;
  color: #241803;
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: 0.02em;
  white-space: nowrap;
}

/* 档位按钮：透明底、基色文字；激活档不再自身改色（变色由遮罩揭示完成）。 */
.thinking-switch-option {
  position: relative; /* z-index auto：不建独立层，文字层才能浮到色块之上 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 48px;
  flex: 0 0 48px;
  padding: 0 4px;
  border: 0;
  background: transparent;
  color: var(--terraria-muted);
  font-family: inherit;
  font-size: 12px;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: 0.02em;
  cursor: pointer;
  white-space: nowrap;
  transition: color 0.15s ease;

  &:hover:not(.active):not(:disabled) {
    color: var(--terraria-ink);
  }

  &:disabled {
    cursor: default;
    opacity: 0.5;
  }
}

/* 文字层：永远在色块之上，色块滑过时标签保持可读 */
.thinking-switch-copy {
  position: relative;
  z-index: 2;
  display: inline-flex;
  align-items: center;
}

.thinking-pop-enter-active,
.thinking-pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.thinking-pop-enter-from,
.thinking-pop-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
</style>

<!-- 胶囊 hover 详情（el-tooltip teleport 到 body，需非 scoped 全局样式） -->
<style lang="less">
.role-detail-popper.el-popper {
  --el-popper-padding: 0;
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--ink) 14%, transparent);
  border-radius: 8px;
  background: var(--surface-hover);
  box-shadow: 0 8px 22px color-mix(in srgb, var(--ink) 20%, transparent);
  color: var(--ink);

  .role-detail {
    display: grid;
    gap: 5px;
  }

  .role-detail-title {
    color: var(--ink);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.3;
  }

  .role-detail-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 14px;
    font-size: 13px;
    line-height: 1.4;
    white-space: nowrap;
  }

  .role-detail-key {
    color: color-mix(in srgb, var(--ink) 54%, transparent);
  }

  .role-detail-value {
    color: color-mix(in srgb, var(--ink) 86%, transparent);
  }

  .sense-detail-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    max-width: 240px;
  }

  .sense-detail-tool {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
    border-radius: 6px;
    background: var(--surface);
    font-size: 13px;
    line-height: 1;
    cursor: default;
  }

  .sense-detail-empty {
    color: color-mix(in srgb, var(--ink) 44%, transparent);
    font-size: 13px;
  }
}
</style>
