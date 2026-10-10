<script setup lang="ts">
import { ref, watch } from 'vue'
const props = defineProps<{
  modelValue: string
  label: string
  autocomplete?: string
  required?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const visible = ref(false)
watch(
  () => props.modelValue,
  (value) => {
    if (!value) visible.value = false
  },
)
</script>
<template>
  <div class="password-field">
    <input
      :value="modelValue"
      :type="visible ? 'text' : 'password'"
      :aria-label="label"
      :placeholder="label"
      :autocomplete="autocomplete"
      :required="required"
      @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    />
    <button
      type="button"
      :aria-label="visible ? '隐藏密码' : '显示密码'"
      :aria-pressed="visible"
      @click="visible = !visible"
    >
      {{ visible ? '隐藏' : '显示' }}
    </button>
  </div>
</template>
