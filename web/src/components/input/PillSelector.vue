<script setup lang="ts">
import { computed } from 'vue'

interface PillOption {
  value: string
  label: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    options: PillOption[]
    placeholder?: string
    maxPills?: number
    disabled?: boolean
  }>(),
  {
    placeholder: '（未选）',
    maxPills: 6,
    disabled: false,
  },
)

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const usePills = computed(() => props.options.length <= props.maxPills)

function select(value: string) {
  if (props.disabled) return
  emit('update:modelValue', value)
}
</script>

<template>
  <div v-if="usePills" class="pill-selector">
    <button
      class="pill-btn"
      :class="{ active: modelValue === '' }"
      :disabled="disabled"
      @click="select('')"
    >
      {{ placeholder }}
    </button>
    <button
      v-for="opt in options"
      :key="opt.value"
      class="pill-btn"
      :class="{ active: modelValue === opt.value }"
      :disabled="disabled"
      @click="select(opt.value)"
    >
      {{ opt.label }}
    </button>
  </div>
  <el-select
    v-else
    :model-value="modelValue"
    size="small"
    :disabled="disabled"
    @update:model-value="select($event as string)"
  >
    <el-option :label="placeholder" value="" />
    <el-option v-for="opt in options" :key="opt.value" :label="opt.label" :value="opt.value" />
  </el-select>
</template>

<style scoped lang="less">
@import '../shared.less';
</style>
