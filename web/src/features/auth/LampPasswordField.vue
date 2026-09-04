<script setup lang="ts">
/**
 * LampPasswordField：带手电开关的原生密码输入框。
 * 灯灭时 input 为 password，灯亮时才切换为 text；使用 v-model 更新 input property，
 * 不把密码写进 value 属性，也不复制到普通 DOM 文本层。
 */
import { ref } from 'vue'

const props = withDefaults(
  defineProps<{
    lit?: boolean
    disabled?: boolean
    autocomplete?: string
    /** 主题（父级由 theme store 传入）：浅色黑光——暗斑配白字（纯 scoped class 驱动）。 */
    theme?: 'light' | 'dark'
  }>(),
  { lit: false, disabled: false, autocomplete: 'current-password', theme: 'dark' },
)
const password = defineModel<string>({ required: true })
const emit = defineEmits<{
  (e: 'update:lit', v: boolean): void
}>()

const wellRef = ref<HTMLElement | null>(null)
const switchRef = ref<HTMLButtonElement | null>(null)
const focused = ref(false)

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
        <input
          v-model="password"
          class="lamp-input"
          :type="lit ? 'text' : 'password'"
          :disabled="disabled"
          :autocomplete="autocomplete"
          aria-label="密码"
          autocapitalize="none"
          spellcheck="false"
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

/* —— 单一原生 input：灯开关只切换 type=password/text —— */
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
  color: color-mix(in srgb, var(--ink) 45%, transparent);
  caret-color: var(--accent);
  font: 400 15px/22px var(--font-mono, monospace);
  outline: none;
}
.is-lit .lamp-input {
  z-index: 3003;
  color: var(--bg);
}
.is-light.is-lit .lamp-input {
  color: color-mix(in srgb, white 92%, var(--accent));
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
