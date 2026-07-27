<script setup lang="ts">
/**
 * ScatterCard：GlobalTab 散落浮动玻璃卡片的「交互壳」。
 *
 * 职责分离（plans/1-2-floating-willow.md §7）：
 *  - 本组件只承载散落交互（拖拽 / 置顶 / 入场 / pointer 绑定）+ neon-block 通用视觉。
 *  - 业务内容由各 *Card.vue 经默认 slot 注入；编号经 #default slot prop（no）回流给业务卡头。
 *  - 散落细节经 SCATTER_KEY inject 取（GlobalTab 调 useCardScatter 后 provide），业务卡不感知散落 API。
 *  - 装饰载流（--block-neon 颜色 + 圆角变体）由 accent / radius props 注入，消除原 7 个 .block-* 选择器。
 */
import { inject, computed } from 'vue'
import { SCATTER_KEY, type GlobalCardAnchor } from '../../useCardScatter'

const props = defineProps<{
  /** 锚点键：与 SCATTER_TABLE / visibleAnchors 对齐，键控散落位置与编号。 */
  anchor: GlobalCardAnchor
  /** 卡片主色（--block-neon）：驱动 ::before/::after 光晕颜色。 */
  accent: string
  /** 圆角变体（如 '16px 9px 13px 8px'）；缺省回退 .neon-block 默认 12px。 */
  radius?: string
}>()

// 编排器（GlobalTab）必 provide SCATTER_KEY；缺失即用错上下文，显性失败优于 undefined 运行时报错。
const scatter = inject(SCATTER_KEY)
if (!scatter) {
  throw new Error('ScatterCard 必须在 GlobalTab（provide SCATTER_KEY）内使用')
}

/** 合并散落定位样式 + 装饰载流（颜色 / 圆角）。 */
const sectionStyle = computed(() => [
  { '--block-neon': props.accent, 'border-radius': props.radius },
  scatter.cardStyle(props.anchor),
])
</script>

<template>
  <section
    class="neon-block"
    :data-anchor="anchor"
    :style="sectionStyle"
    :class="scatter.cardClass(anchor)"
    @pointerdown="scatter.onPointerDown(anchor, $event)"
    @pointermove="scatter.onPointerMove"
    @pointerup="scatter.endPointer"
    @pointercancel="scatter.endPointer"
    @animationend="scatter.onEnterEnd(anchor)"
  >
    <slot :no="scatter.cardNumber(anchor)" />
  </section>
</template>

<style scoped lang="less">
@import '../../../config/shared.less';

// ── 卡片本体：absolute + left/top 由 --cx/--cy 驱动（drag 改这两个值） ──
// 静止无 transform：旋转/缩放会让 backdrop-filter + 文字子像素采样发糊；只有置顶/按下才放大。
.neon-block {
  .neon-glass();
  position: absolute;
  left: var(--cx, 0);
  top: var(--cy, 0);
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease,
    filter 0.18s ease;
  touch-action: none;
  // 卡片整体禁选：长按未到点（0–320ms）/ 短按拖动窗口内也不会选中静态文本，拖拽不糊字
  user-select: none;
  // 玻璃态：在 .neon-glass() 默认 blur(14px) 上加深 + 加 saturate
  backdrop-filter: blur(16px) saturate(1.06);
  // 后卡轻微去饱和，让 .is-top 的 filter:none 凸显层次
  filter: saturate(0.96);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 9px;
  border: 1px solid rgba(129, 140, 248, 0.17);
  border-radius: 12px;
  cursor: grab;
}
.neon-block::before {
  content: '';
  position: absolute;
  width: 110px;
  height: 110px;
  border-radius: 50%;
  right: -45px;
  top: -54px;
  background: rgba(99, 102, 241, 0.16);
  filter: blur(22px);
  pointer-events: none;
}
.neon-block::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 34%;
  top: 0;
  height: 1px;
  background: linear-gradient(90deg, var(--block-neon, #818cf8), transparent);
  box-shadow: 0 0 7px var(--block-neon, #818cf8);
  opacity: 0.58;
  pointer-events: none;
}
.neon-block:nth-child(3n)::before {
  background: rgba(14, 165, 233, 0.16);
}
.neon-block:nth-child(3n + 2)::before {
  background: rgba(217, 70, 233, 0.13);
}

// ── 状态变体 ──
.neon-block.is-top {
  // 顶卡：放大（悬浮感）+ 更深模糊 + saturate 凸显 + 边光（玻璃遮挡后卡的视觉机制）
  backdrop-filter: blur(20px) saturate(1.12);
  filter: none;
  transform: scale(1.03);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.82),
    0 18px 38px rgba(67, 56, 202, 0.18),
    0 0 0 1px rgba(255, 255, 255, 0.08);
}
.neon-block.is-pressed {
  // 「拿起」：放大 1.045 + 加深阴影（长按 / 拖拽中持续保持）
  transform: scale(1.045);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.82),
    0 22px 44px rgba(67, 56, 202, 0.22);
}
.neon-block.is-dragging {
  cursor: grabbing;
  // 拖拽中禁 transition 跟手感跟手；放手回弹时再让 transition 接管
  transition: none;
}

// ── 坠落入场动画：每次进入 global tab 重放，stagger 由 --i 控制；落点无 transform（防糊） ──
@keyframes card-fall {
  from {
    opacity: 0;
    transform: translateY(-40px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.neon-block.is-entering {
  animation: card-fall 0.5s cubic-bezier(0.2, 0.9, 0.25, 1.15) both;
  animation-delay: calc(var(--i) * 55ms);
}

// ── slot 内通用元素密度（业务卡头 / 表单控件）经 :deep 穿透 ──
// 卡顶英文前的序号 + kicker：融合进等宽小字
.neon-block :deep(.block-kicker) {
  position: relative;
  font:
    800 9px/1 ui-monospace,
    SFMono-Regular,
    monospace;
  letter-spacing: 0.14em;
  color: rgba(79, 70, 229, 0.55);
}
.neon-block :deep(.block-kicker .kicker-no) {
  padding-right: 5px;
  margin-right: 5px;
  opacity: 0.5;
}
.neon-block :deep(h3) {
  position: relative;
  margin: 0;
  font-size: 13px;
  color: #3730a3;
}
.neon-block :deep(.field) {
  gap: 2px;
}
.neon-block :deep(.lbl) {
  font-size: 10px;
}
.neon-block :deep(.el-input__wrapper),
.neon-block :deep(.el-select__wrapper) {
  min-height: 28px;
  background: rgba(255, 255, 255, 0.72);
  box-shadow: 0 0 0 1px rgba(99, 102, 241, 0.12) inset;
}
.neon-block :deep(.el-input__inner),
.neon-block :deep(.el-select__selected-item),
.neon-block :deep(.el-select__placeholder) {
  font-size: 11px;
  line-height: 18px;
}
.neon-block :deep(.el-input__inner) {
  height: 26px;
}
.neon-block :deep(.el-input__wrapper.is-focus),
.neon-block :deep(.el-select__wrapper.is-focused) {
  box-shadow:
    0 0 0 1px rgba(56, 189, 248, 0.62) inset,
    0 0 10px rgba(99, 102, 241, 0.15);
}
// 卡片整体禁选后，表单控件内部仍允许选中/编辑（保 NeonNumberControl / el-input 可用）
.neon-block :deep(.el-input__inner),
.neon-block :deep(.el-textarea__inner),
.neon-block :deep(.el-select__input) {
  user-select: text;
}

// ── 窄屏兜底：散落失效，卡回退静态流 ──
@media (max-width: 760px) {
  .neon-block {
    position: static;
    left: auto !important;
    top: auto !important;
    transform: none !important;
  }
}

// reduced-motion 全局降级见 neon.less；这里不重复声明。
</style>
