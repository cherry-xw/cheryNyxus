<script setup lang="ts">
/**
 * LampPasswordField：密码显字层（登录窗 2026-09 重置 v3）。
 * 面板级手电光束（rift-light）由 ServerLoginDialog 驱动，光源即本组件右侧的
 * 手电筒开关按钮；本组件只保留显字三层：透明文字 input（caret 可见）→ 圆点层
 * → 原文层（灯光区域经锥形 clip-path 显形，中线随父级注入的 var(--reveal-y) 晃动）。
 * 配色（v10 对称显字：暗底浅光深字 ↔ 亮底黑光浅字）：显字层无自带底块——
 * 光柱本体即显字底，深色模式显字 = 暖光柱上反深字（--bg）；浅色黑光上反白字（ink 派生）。
 */
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    modelValue: string
    lit?: boolean
    disabled?: boolean
    autocomplete?: string
    /** 主题（父级由 theme store 传入）：浅色黑光——暗斑配白字（纯 scoped class 驱动）。 */
    theme?: 'light' | 'dark'
  }>(),
  { lit: false, disabled: false, autocomplete: 'current-password', theme: 'dark' },
)
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'update:lit', v: boolean): void
}>()

const wellRef = ref<HTMLElement | null>(null)
const switchRef = ref<HTMLButtonElement | null>(null)
const focused = ref(false)

const dots = computed(() => '•'.repeat([...props.modelValue].length))

function onInput(e: Event): void {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}

defineExpose({ wellElement: wellRef, switchElement: switchRef })
</script>

<template>
  <div
    class="lamp-field"
    :class="{ 'is-lit': lit, 'is-focus': focused, 'is-light': props.theme === 'light' }"
  >
    <span class="lamp-label">密码</span>
    <div class="lamp-row">
      <div ref="wellRef" class="lamp-well">
        <div class="lamp-layer lamp-dots" aria-hidden="true">{{ dots }}</div>
        <div class="lamp-layer lamp-plain" aria-hidden="true">{{ modelValue }}</div>
        <input
          class="lamp-input"
          type="text"
          :value="modelValue"
          :disabled="disabled"
          :autocomplete="autocomplete"
          aria-label="密码"
          spellcheck="false"
          @input="onInput"
          @focus="focused = true"
          @blur="focused = false"
        />
      </div>
      <button
        ref="switchRef"
        type="button"
        class="lamp-switch"
        :class="{ 'is-on': lit }"
        :aria-pressed="lit"
        :title="lit ? '熄灯（隐藏原文）' : '开灯（显示原文）'"
        :disabled="disabled"
        @click="emit('update:lit', !lit)"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <!-- 手电筒侧视：灯头朝左（灯头口即光束起点）+ 筒身 + 开关块；开灯时灯头口显出光线 -->
          <path class="lamp-head" d="M2.2 5.6 L4.6 6.6 V9.4 L2.2 10.4 Z" />
          <rect class="lamp-body" x="4.6" y="6.8" width="7.4" height="2.4" />
          <rect class="lamp-btn" x="8.6" y="7.4" width="1.8" height="1.2" />
          <path class="lamp-rays" d="M1.7 6.4 L0.5 5.8 M1.7 8 L0.4 8 M1.7 9.6 L0.5 10.2" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped lang="less">
.lamp-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.lamp-label {
  position: relative;
  /* 高于光柱（面板级 rift-light z 3001）：光带擦过 label 时文字不被吞 */
  z-index: 3003;
  font-size: 12px;
  font-weight: 600;
  opacity: 0.7;
}
.lamp-row {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

/* —— 输入井 —— */
.lamp-well {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 42px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 0;
  overflow: hidden;
  transition:
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}
.lamp-field.is-focus .lamp-well {
  border-color: var(--accent);
  box-shadow: inset 0 0 12px var(--accent-glow);
}
/* 深色模式框体描边提档（v10）：深底上 --border（α0.14）过淡，框体不可辨 */
.lamp-field:not(.is-light) .lamp-well {
  border-color: var(--border-strong);
}

/* —— 文字层（与 input 严格同字体同内边距，mono 保证逐字符对齐） —— */
.lamp-layer {
  position: absolute;
  inset: 0;
  padding: 10px 12px;
  font: 400 15px/22px var(--font-mono, monospace);
  white-space: pre;
  overflow: hidden;
  pointer-events: none;
}
.lamp-dots {
  color: color-mix(in srgb, var(--ink) 45%, transparent);
}
/* 原文层：常态不可见（v5 修复——此前漏了默认隐藏导致密文常显明文）。
   亮灯时整层提到光柱之上（z 3003 > rift-light 3001，被井 overflow 裁在井内）。
   v10：无自带底块——光柱本体即显字底（废弃 surface 深色底块，消除"浅光上叠深光"
   且底块被井边硬裁成"光被输入框遮挡"的伪影）；深色模式 = 暖光柱上反深字（--bg），
   浅色模式由 .is-light 反白 */
.lamp-plain {
  color: var(--bg);
  opacity: 0;
  z-index: 1;
  transition: opacity 0.2s ease;
}

/* —— 锥形显字：右细左粗；右缘（近灯头）中线随 var(--reveal-y)、半高随光束近端
   var(--beam-half-near)，左缘（远端）中线随 var(--reveal-y-far)、半高随光束远端
   var(--beam-half-far)（父级 rAF 注入，局部坐标）——摆动/缩放时显字带均不脱节 —— */
.is-lit .lamp-plain {
  opacity: 1;
  z-index: 3003;
  clip-path: polygon(
    100% calc(var(--reveal-y, 22px) - var(--beam-half-near, 4px)),
    0 calc(var(--reveal-y-far, var(--reveal-y, 22px)) - var(--beam-half-far, 34px) * 0.88),
    0 calc(var(--reveal-y-far, var(--reveal-y, 22px)) + var(--beam-half-far, 34px) * 0.88),
    100% calc(var(--reveal-y, 22px) + var(--beam-half-near, 4px))
  );
}

/* —— 浅色模式：黑光——白字直接浮在黑光柱上（theme prop 驱动，纯 scoped；v10 起同样无底块） —— */
.is-light.is-lit .lamp-plain {
  color: color-mix(in srgb, white 92%, var(--accent));
}

/* —— 真实 input：文字透明仅 caret，置顶接收交互；开灯时同层提到光上，caret 不被光吞 —— */
.lamp-input {
  position: absolute;
  inset: 0;
  z-index: 3;
  width: 100%;
  box-sizing: border-box;
  padding: 10px 12px;
  background: transparent;
  border: 0;
  border-radius: 0;
  color: transparent;
  caret-color: var(--accent);
  font: 400 15px/22px var(--font-mono, monospace);
  outline: none;
}
.is-lit .lamp-input {
  z-index: 3003;
}
.lamp-input::placeholder {
  color: color-mix(in srgb, var(--ink) 38%, transparent);
}

/* —— 手电筒开关 —— */
.lamp-switch {
  flex: none;
  width: 40px;
  border: 1px solid var(--border);
  border-radius: 0;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 55%, transparent);
  cursor: pointer;
  display: grid;
  place-items: center;
  padding: 0;
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}
.lamp-switch:hover {
  border-color: var(--accent);
}
.lamp-switch.is-on {
  color: var(--accent);
  border-color: var(--accent);
  box-shadow: 0 0 10px var(--accent-glow);
}
.lamp-switch svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.2;
  stroke-linecap: square;
  stroke-linejoin: miter;
  /* 与光束刚体一致（父级 stage 注入）：同角度旋转（灯与光角度零偏差）+ 同相 ±2px
     浮动（16px 小图标上纯旋转不可见，可见晃动感由浮动提供），灯头口始终贴住光束发射点 */
  transform: translateY(var(--lamp-bob, 0px)) rotate(var(--beam-tilt, 0deg));
  transform-origin: 14% 50%;
}
.lamp-head {
  fill: currentColor;
  fill-opacity: 0.16;
}
.lamp-body {
  fill: currentColor;
  fill-opacity: 0.1;
}
.lamp-btn {
  fill: currentColor;
}
.lamp-rays {
  opacity: 0;
  transition: opacity 0.25s ease;
}
.is-lit .lamp-rays {
  opacity: 1;
}
@media (prefers-reduced-motion: reduce) {
  .lamp-rays {
    transition: none;
  }
}
</style>
