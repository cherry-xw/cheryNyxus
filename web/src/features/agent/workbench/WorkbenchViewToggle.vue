<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { gsap } from 'gsap'
import { useWorkbenchViewMode } from './useWorkbenchViewMode'
import type { WorkbenchViewMode } from '@/features/lite/liteStore'
import { useMotionTier } from '@/composables/useMotionTier'

const props = defineProps<{ windowId: string }>()
const { viewMode, setViewMode } = useWorkbenchViewMode(props.windowId)

// 三档视图：树（节点树主画布）/ 对话（整屏会话气泡视图）/ 精简（lite 紧凑会话视图）。
// 精简是对话的紧凑展示方式，二者同属会话展示家族，与树视图互斥。
const MODES: Array<{ key: WorkbenchViewMode; icon: string; label: string }> = [
  { key: 'tree', icon: '⌘', label: '树' },
  { key: 'conversation', icon: '↺', label: '对话' },
  { key: 'lite', icon: '▤', label: '精简' },
]

const rootEl = ref<HTMLDivElement | null>(null)
const sliderEl = ref<HTMLSpanElement | null>(null)
const maskEl = ref<HTMLDivElement | null>(null)
const buttonEls = ref<Array<HTMLButtonElement | null>>([])

const { spec } = useMotionTier()
// Q弹只在动效偏好为 full 时启用；reduced 档瞬间落位。
// 刻意不依赖渲染质量档位（decoration）：滑块是核心交互反馈，不是装饰层，
// 低渲染档位下也必须能明显看到「色块在移动」，否则看起来就像激活态直接变了个颜色。
const canAnimate = computed(() => spec.value.mode === 'full')

// 色块相对档位左右各留 2px（上下贴满整格高度，保证盖住全部文字不被裁切）。
// 之前四周都留边把色块缩到比文字还小、遮罩还上下剪字，故上下不再留边。
const BLOCK_INSET = 2

const activeIndex = computed(() =>
  Math.max(
    0,
    MODES.findIndex((m) => m.key === viewMode.value),
  ),
)
const activeMode = computed(() => MODES[activeIndex.value] ?? MODES[0]!)

let sliderTimeline: gsap.core.Timeline | null = null
let pendingSync: number | null = null
// 首次挂载直接就位（不做入场 Q弹），之后的档位切换才播 Q弹。
let firstSync = true

// 色块视觉状态（内容盒坐标：x=色块左缘距内容盒左缘的距离，width=色块逻辑宽，scaleX=形变系数）。
// GSAP 只驱动这一个对象，每一帧由 applyVisual 一次性把「色块位移/形变 + 遮罩裁切」写到位，
// 保证形变与文字揭示逐帧同步，且动画帧内零布局读取。
const animState = { x: 0, width: 0, scaleX: 1 }
// 遮罩宽度在 syncSlider 时测量并缓存（布局变化时 ResizeObserver 会重新同步）。
let cachedMaskW = 0

function setButtonEl(index: number, el: unknown): void {
  buttonEls.value[index] = (el as HTMLButtonElement | null) ?? null
}

/**
 * 把遮罩（反色文字层）裁到色块当前覆盖的矩形：
 * 色块盖住的地方显示反色文字，没盖住的地方保持按钮基色——文字变色由遮罩随色块平移完成，
 * 不直接改按钮的字体颜色。上下不裁切（色块整格覆盖文字），只裁左右。
 */
function applyClip(left: number, width: number): void {
  const mask = maskEl.value
  if (!mask || cachedMaskW <= 0) return
  const l = Math.max(0, Math.min(left, cachedMaskW))
  const r = Math.max(0, Math.min(cachedMaskW - left - width, cachedMaskW))
  mask.style.clipPath = `inset(0px ${r.toFixed(2)}px 0px ${l.toFixed(2)}px)`
}

/** 由 animState 一次性写出色块位置/形变（形变并入宽度、绕中心对称）与遮罩裁切。 */
function applyVisual(): void {
  const slider = sliderEl.value
  if (!slider) return
  const { x, width, scaleX } = animState
  const visualW = width * scaleX
  const visualLeft = x + (width - visualW) / 2
  gsap.set(slider, { x: visualLeft, width: visualW })
  applyClip(visualLeft, visualW)
}

/**
 * 把色块与遮罩放到当前激活档位的位置。
 * animate=true 时走 Q弹：位置 elastic 回弹 + 横向挤压-回弹（squash & stretch）；
 * animate=false 直接就位（首挂载 / 布局变化 / 精简动效档）。
 * refs 尚未就绪（挂载时序）时在下一帧重试，保证色块必然落位。
 */
function syncSlider(animate: boolean): void {
  const slider = sliderEl.value
  const mask = maskEl.value
  const buttons = buttonEls.value
  if (!slider || !mask || buttons.length === 0) {
    scheduleSync(animate)
    return
  }
  const btn =
    buttons[activeIndex.value] ?? buttons.find((b): b is HTMLButtonElement => b !== null) ?? null
  if (!btn) {
    scheduleSync(animate)
    return
  }
  pendingSync = null
  // 以遮罩（=容器内容盒）为参照：色块与遮罩都从内容盒左缘起算，x 即色块左缘距内容盒左缘的距离。
  const maskRect = mask.getBoundingClientRect()
  const btnRect = btn.getBoundingClientRect()
  cachedMaskW = maskRect.width
  const x = btnRect.left - maskRect.left + BLOCK_INSET
  const width = btnRect.width - BLOCK_INSET * 2

  sliderTimeline?.kill()
  sliderTimeline = null

  if (!animate || !canAnimate.value) {
    animState.x = x
    animState.width = width
    animState.scaleX = 1
    applyVisual()
    return
  }
  // 三档等宽：宽度恒定，纯左右平移 + Q弹形变（先横向压缩再拉伸回正）。
  sliderTimeline = gsap
    .timeline({ overwrite: 'auto', onUpdate: applyVisual })
    .to(animState, { x, duration: 0.9, ease: 'elastic.out(0.9, 0.45)' }, 0)
    .fromTo(animState, { scaleX: 0.78 }, { scaleX: 1.16, duration: 0.24, ease: 'power2.out' }, 0)
    .to(animState, { scaleX: 1, duration: 0.4, ease: 'power2.out' }, '-=0.18')
}

function scheduleSync(animate: boolean): void {
  if (pendingSync != null) return
  pendingSync = requestAnimationFrame(() => {
    pendingSync = null
    syncSlider(animate)
  })
}

// 挂载与模式切换统一走这里：首挂载/布局变化直接就位，切换档位播 Q弹。
watch(
  activeIndex,
  () => {
    void nextTick(() => {
      syncSlider(!firstSync)
      firstSync = false
    })
  },
  { immediate: true },
)

// 布局变化（窄屏折叠 / 字体加载 / 标题栏元素增删）：色块无动画跟随新位置。
let resizeObserver: ResizeObserver | null = null
watch(
  rootEl,
  (el) => {
    resizeObserver?.disconnect()
    resizeObserver = null
    if (!el) return
    resizeObserver = new ResizeObserver(() => syncSlider(false))
    resizeObserver.observe(el)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  sliderTimeline?.kill()
  sliderTimeline = null
  if (pendingSync != null) {
    cancelAnimationFrame(pendingSync)
    pendingSync = null
  }
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <!-- 记忆说明：hover 提示三档视图含义 + 选择自动记忆（持久化到 localStorage，下次打开保持）。 -->
  <el-tooltip
    :content="`视图模式 · ${activeMode.label}`"
    placement="bottom"
    :show-after="400"
    :hide-after="0"
    :offset="6"
  >
    <div class="workbench-view-toggle" data-window-interactive role="group" aria-label="工作台视图">
      <!-- 独立色块：唯一高亮载体，绝对定位 + 左右平移 + Q弹形变；按钮自身不再增删高亮 -->
      <span ref="sliderEl" class="workbench-view-toggle-slider" aria-hidden="true" />
      <!-- 文字变色遮罩层：复制三档文字（强调底反色），随色块矩形裁切。
           色块盖到的档位文字变反色、其余保持基色——变色由遮罩完成，不改按钮字体颜色。
           aria-hidden 不参与读屏，pointer-events:none 保证点击落到按钮。 -->
      <div ref="maskEl" class="workbench-view-toggle-mask" aria-hidden="true">
        <div class="workbench-view-toggle-track">
          <span v-for="mode in MODES" :key="mode.key" class="workbench-view-toggle-hi">
            <i aria-hidden="true">{{ mode.icon }}</i
            ><span>{{ mode.label }}</span>
          </span>
        </div>
      </div>
      <button
        v-for="(mode, index) in MODES"
        :key="mode.key"
        :ref="(el) => setButtonEl(index, el)"
        type="button"
        :class="{ active: viewMode === mode.key }"
        :aria-pressed="viewMode === mode.key"
        @click="setViewMode(mode.key)"
      >
        <!-- 文字单独一层，永远浮在色块之上：色块滑过时标签始终可读 -->
        <span class="workbench-view-toggle-copy">
          <i aria-hidden="true">{{ mode.icon }}</i
          ><span>{{ mode.label }}</span>
        </span>
      </button>
    </div>
  </el-tooltip>
</template>

<style scoped lang="less">
.workbench-view-toggle {
  position: relative;
  display: inline-flex;
  height: 26px;
  padding: 2px;
  border: 1px solid color-mix(in srgb, var(--accent) 38%, var(--cyber-line));
  background: color-mix(in srgb, var(--cyber-title-bg) 88%, transparent);
  box-shadow: inset 0 0 12px color-mix(in srgb, var(--accent) 8%, transparent);
  // 空间挤压时保持水平：整体不随标题栏压缩，标签文字不换行成竖排
  flex-shrink: 0;
}

/* 独立色块：绝对定位在容器内容盒，上下贴满整格高度（保证盖住全部文字），
   左右随档位各留 2px。高亮唯一载体——按钮自身不再加高亮背景，
   激活态由色块左右平移到位表达，移动中的挤压回弹体现 Q弹。 */
.workbench-view-toggle-slider {
  position: absolute;
  top: 2px; /* 内容盒上缘 */
  bottom: 2px; /* 内容盒下缘 */
  left: 2px; /* 内容盒左缘，x 位移由 JS 驱动 */
  z-index: 1;
  border-radius: 0;
  background: var(--accent);
  box-shadow: 0 0 12px var(--accent-glow);
  pointer-events: none;
}

/* 高亮文字遮罩层：与色块同源定位（内容盒），把反色文字裁到色块矩形。
   色块平移/形变时 clip-path 逐帧跟随，被盖住的文字反色、未盖住处保持基色——
   文字变色由遮罩完成，不改按钮字体颜色。JS 未就位前默认裁空（右侧全收），避免闪出全量反色文字。 */
.workbench-view-toggle-mask {
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
   必须用块级 flex（而非 inline-flex）：行内级元素会参与父容器行盒的基线对齐，
   被宿主字号/行高推导出的基线整体压偏约 1px（高亮反色文字比真实文字低/高），
   块级 flex 从内容盒顶部起算，与按钮行逐像素对齐。 */
.workbench-view-toggle-track {
  display: flex;
  height: 100%;
}

/* 反色文字副本：与按钮等宽等距，仅颜色为强调底专用反色。
   行高 1.5（CJK 友好）：中文系统字体按 1 倍行高渲染会整体偏上/偏下，
   加大行高让字形在行盒内自然居中，再由 flex 把整行盒居中。 */
.workbench-view-toggle-hi {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  box-sizing: border-box;
  width: 56px;
  padding: 0 7px;
  color: var(--accent-ink);
  font: 600 12px/1.5 var(--font-mono);
  letter-spacing: 0.1em;
  white-space: nowrap;
}

.workbench-view-toggle-hi i {
  color: inherit;
  font-style: normal;
  font-size: 12px;
}

button {
  position: relative; /* z-index auto：不建独立层，文字层才能浮到色块之上 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 56px;
  padding: 0 7px;
  border: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 56%, transparent);
  // 行高 1.5（CJK 友好）：中文按 1 倍行高渲染会偏上/偏下，加大行高让字形在行盒内自然居中
  font: 600 12px/1.5 var(--font-mono);
  letter-spacing: 0.1em;
  cursor: pointer;
  white-space: nowrap;
  // 悬浮变色平滑过渡（激活态不改字体颜色，高亮由遮罩揭示完成）
  transition: color 200ms ease;
}

/* 激活档不再自身加高亮/改色（增删高亮已移除，变色由遮罩揭示完成）——
   高亮由色块平移表达，反色文字由遮罩随色块裁切揭示；
   模板中的 active 类名保留，仅作无障碍/测试挂钩，无独立样式。 */

/* 文字层：永远在色块之上，标签在色块滑过时保持可读 */
.workbench-view-toggle-copy {
  position: relative;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

button i {
  color: var(--accent);
  font-style: normal;
  font-size: 12px;
  transition: color 200ms ease;
}

button:hover {
  color: color-mix(in srgb, var(--ink) 82%, transparent);
}

@media (max-width: 760px) {
  button,
  .workbench-view-toggle-hi {
    width: 28px;
  }
  button .workbench-view-toggle-copy > span,
  .workbench-view-toggle-hi > span {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  button,
  button i {
    transition: none;
  }
}
</style>
