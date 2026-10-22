<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import { useSettingsInputError } from '../model/settingsValidation'

const props = withDefaults(
  defineProps<{
    modelValue?: number
    label: string
    tip?: string
    placeholder?: string
    unit?: string
    step?: number
    min?: number
    max?: number
    defaultValue?: number
    integer?: boolean
  }>(),
  { tip: '', placeholder: '默认', unit: '', step: 1, min: Number.NEGATIVE_INFINITY, max: Infinity, integer: true },
)
const emit = defineEmits<{ (e: 'update:modelValue', value: number | undefined): void }>()
const editing = ref(false)
const draft = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const errorId = useId()
const setInputError = useSettingsInputError()
const shown = computed(() => props.modelValue ?? props.defaultValue)
const error = computed(() => {
  const value = props.modelValue
  if (value === undefined) return ''
  if (!Number.isFinite(value)) return '请填写有效数字'
  if (props.integer && !Number.isInteger(value)) return '请填写整数'
  if (value < props.min || value > props.max) return `请填写 ${props.min} 至 ${props.max === Infinity ? '无上限' : props.max} 范围内的数值`
  return ''
})
watch(error, message => setInputError(`global.${props.label}:${errorId}`, message), { immediate: true })
onBeforeUnmount(() => setInputError(`global.${props.label}:${errorId}`, ''))
let initialText = ''

function change(delta: number): void {
  const base = shown.value
  if (base === undefined || !Number.isFinite(base)) return
  emit('update:modelValue', base + delta)
}
function startEdit(): void {
  draft.value = shown.value === undefined ? '' : String(shown.value)
  initialText = draft.value
  editing.value = true
  nextTick(() => {
    inputRef.value?.focus()
    inputRef.value?.select()
  })
}
function commit(): void {
  if (!editing.value) return
  const text = draft.value.trim()
  if (draft.value !== initialText) emit('update:modelValue', text ? Number(text) : undefined)
  editing.value = false
}
</script>

<template>
  <div class="neon-number">
    <el-tooltip :content="tip" :disabled="!tip" :show-after="0"><span class="neon-number-label">{{ label }}</span></el-tooltip>
    <div class="neon-number-console">
      <button type="button" :aria-label="`减少${label}`" :disabled="shown === undefined" @click="change(-step)">−</button>
      <input
        v-if="editing"
        ref="inputRef"
        v-model="draft"
        inputmode="decimal"
        :aria-label="label"
        :aria-invalid="!!error"
        :aria-describedby="error ? errorId : undefined"
        @blur="commit"
        @keydown.enter="commit"
        @keydown.esc="editing = false"
      />
      <button v-else type="button" class="number-readout" :aria-label="`${label}：${shown ?? placeholder}${unit}`" :aria-describedby="error ? errorId : undefined" @click="startEdit">
        <b>{{ shown ?? placeholder }}</b
        ><small v-if="shown !== undefined && unit">{{ unit }}</small>
      </button>
      <button type="button" :aria-label="`增加${label}`" :disabled="shown === undefined" @click="change(step)">＋</button>
    </div>
    <small v-if="error" :id="errorId" role="alert">{{ error }}</small>
    <button v-if="modelValue !== undefined && defaultValue !== undefined" type="button" @click="emit('update:modelValue', undefined)">恢复默认</button>
  </div>
</template>

<style scoped lang="less">
@import '../config/shared.less';
.neon-number {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.neon-number-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  line-height: 13px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 70%, transparent);
}
.neon-number-console {
  height: 29px;
  display: grid;
  grid-template-columns: 25px minmax(0, 1fr) 25px;
  border: 1px solid rgba(99, 102, 241, 0.17);
  border-radius: 8px;
  background: var(--surface-soft);
  overflow: hidden;
}
.neon-number-console > button {
  border: 0;
  background: transparent;
  color: #6366f1;
  cursor: pointer;
}
.neon-number-console > button:first-child {
  border-right: 1px solid rgba(99, 102, 241, 0.1);
}
.neon-number-console > button:last-child {
  border-left: 1px solid rgba(99, 102, 241, 0.1);
}
.neon-number-console > button:hover {
  background: rgba(99, 102, 241, 0.09);
  text-shadow: 0 0 7px rgba(99, 102, 241, 0.5);
}
.number-readout {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 3px;
  color: color-mix(in srgb, var(--ink) 76%, transparent) !important;
  line-height: 1;
}
.number-readout b {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  font:
    700 11px/1.2 ui-monospace,
    SFMono-Regular,
    monospace;
}
.number-readout small {
  font-size: 12px;
  line-height: 1.2;
  color: color-mix(in srgb, var(--ink) 62%, transparent);
}
.neon-number-console input {
  min-width: 0;
  width: 100%;
  height: 100%;
  padding: 0 4px;
  box-sizing: border-box;
  border: 0;
  outline: 0;
  background: rgba(238, 242, 255, 0.78);
  text-align: center;
  font:
    700 11px/1.2 ui-monospace,
    SFMono-Regular,
    monospace;
  color: #4338ca;
  box-shadow: inset 0 0 8px rgba(99, 102, 241, 0.09);
}
[data-theme='dark'] .neon-number-console input {
  background: color-mix(in srgb, #6366f1 14%, var(--surface));
  color: #a5b4fc;
}
/* 控制台 −/＋ 按钮：深色下提亮（输入框已有上方覆盖）。 */
[data-theme='dark'] .neon-number-console > button {
  color: #a5b4fc;
}
</style>
