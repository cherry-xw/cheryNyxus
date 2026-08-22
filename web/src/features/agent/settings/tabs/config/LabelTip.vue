<script setup lang="ts">
/**
 * LabelTip：字段标签 + 可选 info 图标（hover 显详细说明）。
 * 用于去英文后仍晦涩的字段：中文标签自明的直接用 <span class="lbl">，
 * 需补充说明（原英文键/取值范围/单位）的用本组件挂 tip。
 */
import { InfoFilled } from '@element-plus/icons-vue'

defineProps<{ label: string; tip: string }>()
</script>

<template>
  <span class="lbl">
    {{ label }}
    <el-tooltip :content="tip" placement="top" :show-after="120" popper-class="label-tip-popper">
      <InfoFilled class="info-ico" />
    </el-tooltip>
  </span>
</template>

<style scoped lang="less">
.lbl {
  font-size: 11px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 64%, transparent);
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.info-ico {
  width: 12px;
  height: 12px;
  color: color-mix(in srgb, var(--ink) 60%, transparent);
  cursor: help;
  &:hover {
    color: var(--tab-color, #f6b73c);
  }
}
</style>
