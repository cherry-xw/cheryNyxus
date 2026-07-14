<script setup lang="ts">
/**
 * ThinkingLevelKnob：思考强度档位选择器（真放大镜效果）。
 *
 * 视觉与交互：
 *  - 上方固定一个长方形放大镜视窗（带边缘扭曲效果），内部隐藏一个与下方
 *    小轨道共用同一 translateX 的"大轨道"（约 2.2x 缩放），被 overflow:hidden
 *    裁剪后呈现精准放大：视窗正中显示的内容与小轨道中线的内容始终一致。
 *  - 下方为可拖动的小轨道（月相 emoji + 连线）。
 *  - 月相按当前可用档位数量从完整月相序列中等距取样。
 *  - 拖动小轨道让目标档位图标滑入视窗正中，该档位即为选中。
 *  - label 直接显示后端档位值，居中显示在视窗上方。
 *
 * 档位顺序由 props.levels 决定（来自后端按 model 查的 ThinkingLevel[]）。
 *
 * 键盘：
 *  - ArrowLeft/Right 切换档位
 *  - Home/End 跳首尾
 *  - 数字键 1-N 跳指定档
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { ThinkingLevel } from "@/services/agentApi";

const model = defineModel<ThinkingLevel>({ default: "off" });

const props = defineProps<{
  /** 当前模型支持的档位子集（顺序敏感：左→右 = 弱→强）。 */
  levels: readonly ThinkingLevel[];
}>();

interface LevelMeta {
  value: ThinkingLevel;
  label: string;
  /** 视窗激活时的填充色 */
  accent: string;
  /** 视窗文字色 */
  textOnAccent: string;
}

const META: Record<ThinkingLevel, LevelMeta> = {
  off: { value: "off", label: "off", accent: "#5b6271", textOnAccent: "#fff" },
  on: { value: "on", label: "on", accent: "#9a7eaf", textOnAccent: "#fff" },
  low: { value: "low", label: "low", accent: "#e3a548", textOnAccent: "#3a2406" },
  medium: { value: "medium", label: "medium", accent: "#f6b73c", textOnAccent: "#3a2406" },
  high: { value: "high", label: "high", accent: "#d99717", textOnAccent: "#fff7e6" },
};

/** 完整月相标尺；实际档位数较少时从中等距取样。 */
const MOON_PHASES = ["🌑", "🌒", "🌓", "🌔", "🌕"] as const;

function moonFor(index: number, levelCount: number): string {
  if (levelCount <= 1) return MOON_PHASES[0];
  const phaseIndex = Math.round(index * (MOON_PHASES.length - 1) / (levelCount - 1));
  return MOON_PHASES[phaseIndex] ?? MOON_PHASES[0];
}

/** 有效档位序列（过滤无效 + 保序去重）。 */
const validLevels = computed<readonly ThinkingLevel[]>(() => {
  const seen = new Set<ThinkingLevel>();
  const out: ThinkingLevel[] = [];
  for (const l of props.levels) {
    if (l in META && !seen.has(l)) {
      seen.add(l);
      out.push(l);
    }
  }
  return out;
});

/** 当前档位在 validLevels 中的下标；缺省/无效 → 0。 */
const activeIndex = computed(() => {
  const idx = validLevels.value.indexOf(model.value);
  return idx < 0 ? 0 : idx;
});

/** 当前档位的 meta（视窗用）。 */
const activeMeta = computed<LevelMeta>(() => META[validLevels.value[activeIndex.value] ?? "off"] ?? META.off);

// ── DOM 引用 ──────────────────────────────────────────────────────
const trackRef = ref<HTMLElement | null>(null);
const containerRef = ref<HTMLElement | null>(null);
const magnifierRef = ref<HTMLElement | null>(null);
/** 容器内宽（px）。拖动时用容器中心为基准。 */
const containerWidth = ref(0);
/** 放大镜视窗宽（px）。大轨道 translateX 计算依赖它。 */
const magnifierWidth = ref(0);

/** 单个档位点的中心间距（px）。 */
const STEP_GAP = 66;
/**
 * 放大镜缩放比例。
 *  - 小轨道 emoji 10px → 放大后约 22px（视觉舒适）
 *  - 84px 宽视窗对应视野约 38px（1 个完整 emoji + 邻居边缘）
 */
const MAGNIFIER_SCALE = 2.2;

// ── 拖动状态 ──────────────────────────────────────────────────────
/** 拖动中的额外像素位移（未吸附）。 */
const dragDelta = ref(0);
/** 是否正在拖动（影响是否响应吸附）。 */
const isDragging = ref(false);
/** 拖动起始信息。 */
let dragState: {
  startX: number;
  startDelta: number;
  startActiveIndex: number;
  pointerId: number;
  moved: boolean;
} | null = null;

// ── 位置计算 ──────────────────────────────────────────────────────

/**
 * 让第 idx 个档位点对齐容器中心所需的 translateX（不含拖动 delta）。
 * 第 0 个档位的中心在轨道起点后 STEP_GAP / 2，需扣除该半格偏移。
 */
function baseOffsetFor(idx: number): number {
  const half = containerWidth.value / 2;
  // 第 i 个点中心距轨道原点 = STEP_GAP / 2 + i * STEP_GAP
  const pointCenter = STEP_GAP / 2 + idx * STEP_GAP;
  return half - pointCenter;
}

const trackStyle = computed(() => ({
  transform: `translateX(${baseOffsetFor(activeIndex.value) + dragDelta.value}px)`,
  transition: isDragging.value ? "none" : "transform 0.22s cubic-bezier(0.4, 0, 0.2, 1)",
}));

/**
 * 视窗内"大轨道"的 transform：translateX + scale，使视窗正中显示的内容
 * 始终与小轨道中线（T = baseOffset(active) + dragDelta）的内容一致。
 *
 * 推导：
 *  - 小轨道 emoji i 在容器坐标 X = T + STEP_GAP/2 + i*STEP_GAP
 *  - 视窗中心位于容器坐标 M = containerWidth/2，宽度 W
 *  - 视窗覆盖容器范围 [M - W/2, M + W/2]
 *  - 放大后视窗宽 W 对应实际内容宽 W/s，所以容器坐标 p 映射到视窗局部 X：
 *      X_mag = (p - M) * s + W/2
 *  - 代入 p = T + STEP_GAP/2 + i*STEP_GAP：
 *      X_mag = (T + STEP_GAP/2 + i*STEP_GAP - M) * s + W/2
 *  - 大轨道含 i 个 emoji 在其局部坐标 (STEP_GAP/2 + i*STEP_GAP, 0)，经过 scale + translate：
 *      X_screen = T_m + (STEP_GAP/2 + i*STEP_GAP)*s
 *  - 令 X_screen = X_mag：T_m = (T - M) * s + W/2
 */
const magnifiedTrackStyle = computed(() => {
  const T = baseOffsetFor(activeIndex.value) + dragDelta.value;
  const M = containerWidth.value / 2;
  const W = magnifierWidth.value;
  const s = MAGNIFIER_SCALE;
  const T_m = (T - M) * s + W / 2;
  return {
    transform: `translateX(${T_m}px) scale(${s})`,
    transition: isDragging.value ? "none" : "transform 0.22s cubic-bezier(0.4, 0, 0.2, 1)",
  };
});

// ── 行为 ──────────────────────────────────────────────────────────

function selectAt(idx: number): void {
  const v = validLevels.value[idx];
  if (v) model.value = v;
}

function selectRelative(delta: number): void {
  const lastIndex = validLevels.value.length - 1;
  selectAt(Math.max(0, Math.min(lastIndex, activeIndex.value + delta)));
}

/**
 * 由当前 track translateX（= baseOffset(active) + dragDelta）反推最近档位。
 * 拖动中用于实时吸附判定。
 */
function nearestIndexFromOffset(offset: number): number {
  const half = containerWidth.value / 2;
  // pointCenter = half - offset → 找最接近 half - offset 的 i
  // pointCenter(i) = STEP_GAP / 2 + i * STEP_GAP
  // → i = (half - offset - STEP_GAP / 2) / STEP_GAP
  const n = validLevels.value.length;
  if (n === 0) return 0;
  const raw = (half - offset - STEP_GAP / 2) / STEP_GAP;
  const clamped = Math.max(0, Math.min(n - 1, Math.round(raw)));
  return clamped;
}

function measure(): void {
  const el = containerRef.value;
  containerWidth.value = el ? el.clientWidth : 0;
  const m = magnifierRef.value;
  magnifierWidth.value = m ? m.clientWidth : 0;
}

// ── 拖动事件 ──────────────────────────────────────────────────────

function onPointerDown(e: PointerEvent): void {
  // 仅主键（左键或 touch）
  if (e.pointerType === "mouse" && e.button !== 0) return;
  dragState = {
    startX: e.clientX,
    startDelta: dragDelta.value,
    startActiveIndex: activeIndex.value,
    pointerId: e.pointerId,
    moved: false,
  };
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}

function onPointerMove(e: PointerEvent): void {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  const dx = e.clientX - dragState.startX;
  if (!dragState.moved && Math.abs(dx) < 3) return; // 抑制点击抖动
  dragState.moved = true;
  isDragging.value = true;
  // 基于起始index计算candidate,避免基准点漂移
  const candidate = baseOffsetFor(dragState.startActiveIndex) + dragState.startDelta + dx;
  const idx = nearestIndexFromOffset(candidate);
  if (idx !== activeIndex.value) selectAt(idx);
  // activeIndex 改变会改变 baseOffset；重算相对新基准的 delta，保持轨道在指针下连续移动。
  dragDelta.value = candidate - baseOffsetFor(idx);
}

function onPointerUp(e: PointerEvent): void {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  const moved = dragState.moved;
  dragState = null;
  isDragging.value = false;
  // 吸附：吸附到当前 activeIndex（拖动过程中已更新）
  dragDelta.value = 0;
  // 若未发生移动，则视为点击（由点击处理器处理）
  if (!moved) {
    // 什么都不做；点击事件已单独触发
    return;
  }
}

function onPointerCancel(e: PointerEvent): void {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  dragState = null;
  isDragging.value = false;
  dragDelta.value = 0;
}

function onTileClick(idx: number): void {
  if (isDragging.value) return; // 拖动结束时不触发点击
  selectAt(idx);
}

function onKeydown(e: KeyboardEvent): void {
  const n = validLevels.value.length;
  if (n === 0) return;
  if (e.key === "ArrowRight" || e.key === "ArrowUp") {
    e.preventDefault();
    selectRelative(1);
  } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
    e.preventDefault();
    selectRelative(-1);
  } else if (e.key === "Home") {
    e.preventDefault();
    selectAt(0);
  } else if (e.key === "End") {
    e.preventDefault();
    selectAt(n - 1);
  } else if (/^[1-9]$/.test(e.key)) {
    const idx = Number(e.key) - 1;
    if (idx < n) {
      e.preventDefault();
      selectAt(idx);
    }
  }
}

// ── 生命周期 ──────────────────────────────────────────────────────

let ro: ResizeObserver | null = null;

watch(
  containerRef,
  async (el) => {
    if (ro) {
      ro.disconnect();
      ro = null;
    }
    if (!el) return;
    await nextTick();
    measure();
    ro = new ResizeObserver(() => measure());
    ro.observe(el);
    // 视窗宽度变化也需要重测（大轨道 translateX 依赖它）
    const m = magnifierRef.value;
    if (m) ro.observe(m);
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  if (ro) {
    ro.disconnect();
    ro = null;
  }
});
</script>

<template>
  <div
    v-if="validLevels.length > 0"
    class="thinking-knob"
    role="radiogroup"
    aria-label="思考强度"
    tabindex="0"
    @keydown="onKeydown"
  >
    <div ref="containerRef" class="knob-inner">
      <!-- label：直接显示当前后端档位值，固定在视窗上方 -->
      <span class="knob-label">{{ activeMeta.label }}</span>

      <!-- 放大镜视窗（长方形，内部真放大，被 overflow:hidden 裁剪） -->
      <div ref="magnifierRef" class="magnifier-box" aria-hidden="true">
        <div class="magnified-track" :style="magnifiedTrackStyle">
          <span
            v-for="(lvl, i) in validLevels"
            :key="lvl"
            class="mag-level"
            :class="{ current: i === activeIndex }"
          >
            <span v-if="i > 0" class="mag-connector" :class="{ active: i <= activeIndex }" />
            <span class="moon-icon">{{ moonFor(i, validLevels.length) }}</span>
          </span>
        </div>
        <!-- 边缘扭曲效果层（叠加在视窗内容之上，营造镜头感） -->
        <div class="magnifier-edge" />
      </div>

      <button
        type="button"
        class="knob-step-button knob-step-button--previous"
        :disabled="activeIndex === 0"
        aria-label="上一个思考档位"
        @click="selectRelative(-1)"
      >
        <span class="step-chevron" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="knob-step-button knob-step-button--next"
        :disabled="activeIndex === validLevels.length - 1"
        aria-label="下一个思考档位"
        @click="selectRelative(1)"
      >
        <span class="step-chevron" aria-hidden="true" />
      </button>

      <!-- 小轨道：可拖动，包含月相 emoji + 连线 -->
      <div
        ref="trackRef"
        class="track"
        :class="{ dragging: isDragging }"
        :style="trackStyle"
        role="presentation"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerCancel"
      >
        <button
          v-for="(lvl, i) in validLevels"
          :key="lvl"
          type="button"
          class="point-item"
          :class="{ current: i === activeIndex }"
          :aria-checked="i === activeIndex"
          :aria-label="META[lvl]?.label ?? lvl"
          role="radio"
          @click.stop="onTileClick(i)"
        >
          <!-- 连线（点之间） -->
          <span v-if="i > 0" class="point-connector" :class="{ active: i <= activeIndex }" />
          <!-- 与放大镜共用的按档位数等距取样的月相 emoji -->
          <span class="moon-icon" aria-hidden="true">{{ moonFor(i, validLevels.length) }}</span>
        </button>
      </div>
    </div>
  </div>
  <div v-else class="thinking-knob-empty">—</div>
</template>

<style scoped lang="less">
@import "../shared.less";

.thinking-knob {
  position: relative;
  width: 100%;
  height: 72px; // 更高的放大镜 + 轨道 + 底部辅助按钮
  padding: 7px 9px;
  box-sizing: border-box;
  border: 1px solid rgba(36, 38, 45, 0.1);
  border-radius: 6px;
  background: #fff;
  outline: none;
  user-select: none;
  touch-action: pan-y;
  overflow: hidden;

  &:focus-visible {
    box-shadow: 0 0 0 2px fade(@accent, 45%);
    border-radius: 6px;
  }
}

.thinking-knob-empty {
  color: fade(@ink, 36%);
  font-size: 11px;
  text-align: center;
  padding: 6px 0;
}

// ── 内部容器 ──────────────────────────────────────────────────────
.knob-inner {
  position: relative;
  width: 100%;
  height: 100%;
}

// ── label：居中置于放大镜上方，直接显示后端档位值 ─────────────────
.knob-label {
  position: absolute;
  z-index: 3;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  padding: 0 3px;
  font-size: 10px;
  font-weight: 700;
  color: fade(@ink, 60%);
  background: rgba(255, 255, 255, 0.76);
  border-radius: 3px;
  letter-spacing: 0.5px;
  pointer-events: none;
}

// ── 放大镜视窗（长方形，固定在 knob 上半部，真放大效果） ──────────
.magnifier-box {
  position: absolute;
  z-index: 2;
  top: 13px;
  left: 50%;
  transform: translateX(-50%);
  width: 84px;
  height: 36px;
  overflow: hidden;
  border: 1.5px solid fade(@accent, 65%);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.92);
  pointer-events: none;
  // 镜头深度：顶部高光 + 底部阴影 + 整体内阴影
  box-shadow:
    inset 0 1px 1px rgba(255, 255, 255, 0.6),
    inset 0 -1px 1px rgba(0, 0, 0, 0.04),
    inset 0 0 6px rgba(0, 0, 0, 0.06);
}

.knob-step-button {
  position: absolute;
  z-index: 3;
  bottom: -4px;
  width: 22px;
  height: 16px;
  padding: 0;
  border: 0;
  background: transparent;
  color: fade(@ink, 44%);
  cursor: pointer;
  opacity: 0.7;

  display: grid;
  place-items: center;

  &:hover:not(:disabled) {
    color: @accent;
    opacity: 1;
  }

  &:focus-visible {
    outline: 2px solid fade(@accent, 45%);
    outline-offset: 1px;
  }

  &:disabled {
    cursor: default;
    opacity: 0.22;
  }
}

.knob-step-button--previous {
  left: -6px;

  .step-chevron { transform: rotate(135deg); }
}

.knob-step-button--next {
  right: -6px;

  .step-chevron { transform: rotate(-45deg); }
}

.step-chevron {
  width: 6px;
  height: 6px;
  border: solid currentColor;
  border-width: 0 1px 1px 0;
}

// 边缘扭曲效果层（径向渐变 + 左右边缘暗化，模拟镜头曲面）
.magnifier-edge {
  position: absolute;
  inset: 0;
  pointer-events: none;
  border-radius: inherit;
  background:
    // 中央透明，边缘渐暗（径向）
    radial-gradient(ellipse 95% 100% at center,
      transparent 60%,
      rgba(0, 0, 0, 0.10) 100%),
    // 左右边缘进一步暗化（线性）
    linear-gradient(to right,
      rgba(0, 0, 0, 0.12) 0%,
      transparent 14%,
      transparent 86%,
      rgba(0, 0, 0, 0.12) 100%),
    // 顶部高光（玻璃感）
    linear-gradient(to bottom,
      rgba(255, 255, 255, 0.35) 0%,
      transparent 22%);
}

// 视窗内的大轨道（与下方小轨道共用 T，被 scale 放大后裁剪显示）
.magnified-track {
  position: absolute;
  top: 0;
  left: 0;
  height: 100%;
  display: flex;
  align-items: center;
  transform-origin: 0 50%;
  transform: translateY(-50%);
  will-change: transform;
  min-width: max-content;
}

.mag-level {
  position: relative;
  width: 66px; // 与小轨道 STEP_GAP 对齐
  height: 100%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.mag-connector {
  position: absolute;
  z-index: 0;
  top: 50%;
  left: -27px;
  width: 54px;
  height: 1px;
  background: rgba(36, 38, 45, 0.18);

  &.active {
    background: @accent;
  }
}

// ── 小轨道（可拖动，在 knob 下半部） ─────────────────────────────
.track {
  position: absolute;
  z-index: 1;
  bottom: 18px;
  left: 0;
  display: flex;
  align-items: center;
  cursor: grab;
  will-change: transform;
  min-width: max-content;

  &.dragging {
    cursor: grabbing;
  }
}

.point-item {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0;
  border: none;
  background: transparent;
  font: inherit;
  cursor: pointer;
  outline: none;
  width: 66px; // 与 STEP_GAP 保持一致，保证吸附位置与视觉点位重合
  height: 14px;
}

// 连线（点之间）
.point-connector {
  position: absolute;
  top: 50%;
  left: -27px;
  width: 54px;
  height: 1px;
  background: rgba(36, 38, 45, 0.15);
  pointer-events: none;
  z-index: 0;

  &.active {
    background: @accent;
  }
}

// ── 月相图标：按有效档位数从完整月相序列等距取样 ─────────────────
.moon-icon {
  position: relative;
  z-index: 1;
  display: inline-block;
  font-size: 10px;
  line-height: 1;
  filter: grayscale(18%);
  transition: filter 0.18s ease;
}

.mag-level.current .moon-icon,
.point-item.current .moon-icon {
  filter: grayscale(0%);
}
</style>
