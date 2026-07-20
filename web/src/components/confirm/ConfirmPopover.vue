<script setup lang="ts">
/**
 * ConfirmPopover：轻删二次确认浮层。
 * 弃 el-popconfirm（其 title 单行不换行、宽度受限 → 长 cloneUrl 等文案溢出）；
 * 改 el-popover + 自定义内容 slot：min/max-width + word-break 控宽换行。
 * 保留 title prop + confirm/cancel emits + trigger slot，9 处调用点零改动。
 * 用于后果轻的删除（感官组/单技能/MCP/媒体）；重删用 ConfirmDialog 居中 modal。
 * 样式：新拟物化（Neumorphism）--同色系背景 + 内外阴影，hover 切凹陷态。
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
     不 @import shared.less 避免其全部 class 全局污染。
     新拟物化（Neumorphism）：同色系背景 + 内外阴影 = 凸出/凹陷效果。 -->
<style lang="less">
.confirm-popover-popper.el-popover.el-popper {
  padding: 12px 14px;
  border: none;
  border-radius: 12px;
  min-width: 240px;
  max-width: 340px;
  background: #e8e6e1;
  // 外阴影（右下暗）+ 反向外阴影（左上亮）= popper 从背景凸出
  box-shadow:
    8px 8px 16px rgba(0, 0, 0, 0.15),
    -8px -8px 16px rgba(255, 255, 255, 0.7);
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
  padding: 5px 14px;
  border: none;
  border-radius: 8px;
  background: #e8e6e1;
  font-size: 11px;
  font-weight: 700;
  cursor: pointer;
  // 凸出态：外阴影（右下暗 + 左上亮）
  box-shadow:
    3px 3px 6px rgba(0, 0, 0, 0.12),
    -3px -3px 6px rgba(255, 255, 255, 0.6);
  transition:
    box-shadow 0.15s ease,
    color 0.15s ease;
  &:hover {
    // 凹陷态：内阴影（按下效果）
    box-shadow:
      inset 2px 2px 4px rgba(0, 0, 0, 0.1),
      inset -2px -2px 4px rgba(255, 255, 255, 0.5);
  }
  &.cancel {
    color: rgba(20, 22, 26, 0.7);
  }
  &.ok {
    // danger 保留红色文字标识，按钮本体仍 neumorphism 凸出
    color: #b91c1c;
    &:hover {
      color: #dc2626;
    }
  }
}
</style>
