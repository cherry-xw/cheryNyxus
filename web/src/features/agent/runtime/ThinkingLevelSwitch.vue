<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { gsap } from 'gsap'
import { useMotionTier } from '@/composables/useMotionTier'
import { agentApi, type BrainConfigDto, type RuntimeSelection, type ThinkingLevel } from '@/application/backend/public'
import { THINKING_LABEL } from './roleConfigModel'

const props = defineProps<{ selection: RuntimeSelection; brainConfig?: BrainConfigDto }>()
const emit = defineEmits<{ (e: 'update:selection', value: RuntimeSelection): void }>()

const thinkingOpen = ref(false)
let thinkingAnimationTarget: ThinkingLevel | null = null
/** 当前生效的思考档位：临时覆盖优先，缺省用大脑配置默认档位。 */
const effectiveThinking = computed<ThinkingLevel>(() => {
  const sel = props.selection
  return sel.thinking ?? props.brainConfig?.thinking ?? 'off'
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
  emit('update:selection', { ...props.selection, thinking: level })
}
/** 大脑变化 → 重新拉取可用档位；原覆盖不在新模型可用档位里则清除（回落大脑配置默认）。 */
watch(
  () => {
    const sel = props.selection
    const cfg = props.brainConfig
    // 用原语作 watch 键（而非数组）：Vue 对 watch getter 返回值做引用比较，
    // selection 每次更新（含「仅改思考档位」的临时覆盖）都会让本 getter 重新执行并生成新数组引用，
    // 导致本 watch 误触发 → thinkingLevels 被清空重拉 → 切换面板收缩又扩展、色块闪到首位再跳回。
    // 原语键只在 brain/model/provider/protocol 真正变化时才触发。
    return `${sel.brain}\u0000${cfg?.model ?? ''}\u0000${cfg?.provider ?? ''}\u0000${cfg?.protocol ?? ''}`
  },
  async (key) => {
    const [brainName = ''] = key.split('\u0000')
    thinkingLevels.value = []
    const cfg = props.brainConfig
    if (!cfg?.model) return
    try {
      const res = await agentApi.getModelRecommendation(cfg.model, cfg.provider, cfg.protocol)
      thinkingLevels.value = res.thinkingLevels ?? []
    } catch {
      thinkingLevels.value = []
    }
    const override = props.selection.thinking
    if (
      override !== undefined &&
      thinkingLevels.value.length > 0 &&
      !thinkingLevels.value.includes(override)
    ) {
      emit('update:selection', { ...props.selection, thinking: undefined })
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
    <div class="thinking-control" :class="{ 'is-open': thinkingOpen }">
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

</template>

<style scoped lang="less">
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

:global(.terraria-role-card:hover) .thinking-control,
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
