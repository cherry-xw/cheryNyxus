<script setup lang="ts">
import { computed } from 'vue'
import { computeSelectionTokens } from '../config/shared'

const props = withDefaults(
  defineProps<{
    modelValue?: string[]
    options: string[]
    tokenMap?: Record<string, number>
    label: string
    inheritLabel?: string
    disabled?: boolean
  }>(),
  { tokenMap: () => ({}), inheritLabel: '继承全部' },
)

const emit = defineEmits<{
  (e: 'update:modelValue', value: string[] | undefined): void
  (e: 'edit'): void
  (e: 'mode-change'): void
}>()

const mode = computed(() =>
  props.modelValue === undefined ? 'inherit' : props.modelValue.length ? 'custom' : 'none',
)
const tokens = computed(() =>
  computeSelectionTokens(props.modelValue, props.options, props.tokenMap),
)

function setMode(value: string[] | undefined): void {
  if (props.disabled) return
  emit('update:modelValue', value)
  emit('mode-change')
}
</script>

<template>
  <section class="equipment-slot" :class="{ overloaded: tokens > 5000, disabled }">
    <header>
      <span
        ><b>{{ label }}</b
        ><small>{{
          mode === 'inherit'
            ? inheritLabel
            : mode === 'none'
              ? '全不使用'
              : `已装备 ${modelValue?.length ?? 0}`
        }}</small></span
      >
      <span class="equipment-token">≈ {{ tokens }} token</span>
    </header>
    <div class="equipment-mode">
      <button
        type="button"
        :disabled="disabled"
        :class="{ active: mode === 'inherit' }"
        @click="setMode(undefined)"
      >
        继承全部
      </button>
      <button
        type="button"
        :disabled="disabled"
        :class="{ active: mode === 'custom' }"
        @click="emit('edit')"
      >
        自选装备
      </button>
      <button
        type="button"
        :disabled="disabled"
        :class="{ active: mode === 'none' }"
        @click="setMode([])"
      >
        全不使用
      </button>
    </div>
    <button
      v-if="mode === 'custom'"
      type="button"
      class="manage-btn"
      :disabled="disabled"
      @click="emit('edit')"
    >
      整理装备
    </button>
    <p v-if="tokens > 5000" class="equipment-warning">
      装备较多会增加每次对话的默认系统提示词体积。
    </p>
  </section>
</template>

<style scoped lang="less">
@import '../config/shared.less';
.equipment-slot {
  padding: 9px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 9px;
  background: var(--surface-soft);
  display: flex;
  flex-direction: column;
  gap: 7px;
  transition:
    border-color 0.15s ease,
    box-shadow 0.15s ease;
}
.equipment-slot.overloaded {
  border-color: color-mix(in srgb, var(--warning) 45%, transparent);
}
.equipment-slot.disabled {
  opacity: 0.72;
}
.equipment-slot header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.equipment-slot header span:first-child {
  min-width: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
}
.equipment-slot b {
  font-size: 12px;
}
.equipment-slot small {
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
}
.equipment-token {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 700;
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
}
.equipment-mode {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}
.equipment-mode button {
  height: 25px;
  border: 1px solid color-mix(in srgb, var(--ink) 13%, transparent);
  border-radius: 7px;
  background: var(--surface);
  color: color-mix(in srgb, var(--ink) 62%, transparent);
  font-size: 10px;
  cursor: pointer;
}
.equipment-mode button.active {
  background: color-mix(in srgb, var(--tab-color, @accent) 15%, var(--surface));
  border-color: color-mix(in srgb, var(--tab-color, @accent) 48%, transparent);
  color: color-mix(in srgb, var(--tab-color, @accent) 76%, @ink);
  font-weight: 800;
}
.equipment-mode button:disabled,
.manage-btn:disabled {
  cursor: not-allowed;
}
.manage-btn {
  align-self: flex-start;
  min-height: 24px;
  padding: 2px 10px;
  border: 1px dashed color-mix(in srgb, var(--tab-color, @accent) 50%, transparent);
  border-radius: 999px;
  background: color-mix(in srgb, var(--tab-color, @accent) 8%, transparent);
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  font-size: 10px;
  cursor: pointer;
}
.equipment-warning {
  margin: 0;
  font-size: 10px;
  color: var(--warning);
}
</style>
