<script setup lang="ts">
/**
 * EditableTitle：可点击改名的卡片标题（内联编辑公共组件）。
 *BrainsTab / SensesTab 原各自重复的内联编辑逻辑抽此；RolesTab / PresetsTab 经此获得改名能力。
 * - 单击进入编辑（v-focus 自动聚焦 input），Enter 提交 / Esc 取消；Check·Close 按钮同效
 * - validate 返回非空错误串 → emit('error') 并保持编辑态（如重名提示）；返回 null → emit('rename') 退出编辑
 * - #actions 具名插槽：非编辑态的额外按钮（复制/删除等）；编辑态自动隐藏（显 Check/Close）
 */
import { ref } from 'vue'
import { Check, Close } from '@element-plus/icons-vue'

const props = defineProps<{
  modelValue: string
  /** 提交前校验：返回错误提示串（保持编辑态 + emit error）或 null（通过） */
  validate?: (newName: string) => string | null
}>()
const emit = defineEmits<{
  (e: 'rename', newName: string): void
  (e: 'error', msg: string): void
}>()

const editing = ref(false)
const editValue = ref('')
const vFocus = { mounted: (el: HTMLElement) => el.querySelector('input')?.focus() }

function start(): void {
  editing.value = true
  editValue.value = props.modelValue
  emit('error', '')
}
function cancel(): void {
  editing.value = false
  editValue.value = ''
}
function commit(): void {
  const newName = editValue.value.trim()
  if (!newName || newName === props.modelValue) {
    editing.value = false
    return
  }
  const err = props.validate?.(newName) ?? null
  if (err) {
    emit('error', err)
    return // 保持编辑态，等用户改
  }
  emit('rename', newName)
  editing.value = false
}

// 暴露 start 给父组件（RolesTab 复制后自动进入改名态），替代脆弱的 querySelector(.click())。
defineExpose({ start })
</script>

<template>
  <span class="card-title">
    <el-input
      v-if="editing"
      v-model="editValue"
      v-focus
      class="card-name-input"
      size="small"
      @keydown.enter="commit"
      @keydown.esc="cancel"
    />
    <span v-else class="card-name editable" title="点击改名" @click="start">{{ modelValue }}</span>
    <span class="card-actions">
      <template v-if="editing">
        <button type="button" class="icon-btn ok" aria-label="确认改名" @click="commit">
          <Check class="ico" />
        </button>
        <button type="button" class="icon-btn" aria-label="取消" @click="cancel">
          <Close class="ico" />
        </button>
      </template>
      <slot v-else name="actions" />
    </span>
  </span>
</template>

<style scoped lang="less">
@import '@/features/agent/settings/config/shared.less';
</style>
