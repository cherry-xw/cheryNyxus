<script setup lang="ts">
/**
 * ConfirmPopover：轻删二次确认浮层。
 * 弃 el-popconfirm（其 title 单行不换行、宽度受限 → 长 cloneUrl 等文案溢出）；
 * 改 el-popover + 自定义内容 slot：min/max-width + word-break 控宽换行。
 * 保留 title prop + confirm/cancel emits + trigger slot，9 处调用点零改动。
 * 用于后果轻的删除（感官组/单技能/MCP/媒体）；重删用 ConfirmDialog 居中 modal。
 */
import { ref } from 'vue'

defineProps<{ title: string }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()

const visible = ref(false)
function onConfirm(): void {
  emit('confirm')
  visible.value = false
}
function onCancel(): void {
  emit('cancel')
  visible.value = false
}
</script>

<template>
  <el-popover
    v-model:visible="visible"
    trigger="click"
    placement="top"
    popper-class="confirm-popover-popper"
  >
    <template #reference>
      <slot name="trigger" />
    </template>
    <div class="confirm-pop">
      <p class="confirm-pop-title">{{ title }}</p>
      <div class="confirm-pop-actions">
        <button type="button" class="cp-btn cancel" @click="onCancel">取消</button>
        <button type="button" class="cp-btn ok" @click="onConfirm">删除</button>
      </div>
    </div>
  </el-popover>
</template>

<!-- 非 scoped：el-popover popper 渲染到 body（element 内部 DOM，无 data-v），需全局 class。
     不 @import shared.less 避免其全部 class 全局污染；色值硬编码（仅 danger 红玻璃底）。 -->
<style lang="less">
.confirm-popover-popper.el-popover.el-popper {
  padding: 12px 14px;
  border-radius: 10px;
  min-width: 240px;
  max-width: 340px;
  background: linear-gradient(155deg, rgba(255, 255, 255, 0.72), rgba(238, 242, 255, 0.5));
  backdrop-filter: blur(14px);
  border: 1px solid rgba(239, 68, 68, 0.4);
  box-shadow:
    0 4px 20px rgba(185, 28, 28, 0.18),
    0 0 10px rgba(239, 68, 68, 0.16);
}
.confirm-pop {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.confirm-pop-title {
  margin: 0;
  font-size: 12px;
  font-weight: 600;
  line-height: 1.5;
  color: rgba(20, 22, 26, 0.84);
  white-space: normal;
  word-break: break-all;
}
.confirm-pop-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.cp-btn {
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  transition:
    filter 0.15s ease,
    background-color 0.15s ease;
  &.cancel {
    border: 1px solid rgba(36, 38, 45, 0.18);
    background: rgba(255, 255, 255, 0.7);
    color: rgba(20, 22, 26, 0.7);
    &:hover {
      background: #fff;
    }
  }
  &.ok {
    border: none;
    background: linear-gradient(135deg, #ef4444, #b91c1c);
    color: #fff;
    &:hover {
      filter: brightness(1.08);
    }
  }
}
</style>
