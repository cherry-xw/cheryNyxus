<script setup lang="ts">
/**
 * ConfirmPopover：删除二次确认浮层（el-popconfirm 薄封装）。
 * 保留 title prop + confirm/cancel emits + trigger slot，调用点零改动。
 * trigger slot -> el-popconfirm #reference；element 接管浮层/定位/outside-click/Esc。
 * confirm 按钮设 danger 类型（删除语义）。
 */
defineProps<{ title: string }>();
defineEmits<{ confirm: []; cancel: [] }>();
</script>

<template>
  <el-popconfirm
    :title="title"
    confirm-button-type="danger"
    @confirm="$emit('confirm')"
    @cancel="$emit('cancel')"
  >
    <template #reference>
      <slot name="trigger" />
    </template>
  </el-popconfirm>
</template>
