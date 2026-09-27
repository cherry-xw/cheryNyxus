<script setup lang="ts">
/**
 * WorkbenchAttentionIndicator：树模式待处理交互的标题栏指示器。
 *
 * 不可点击的 ⚠ 图标（无任何点击行为），持续硬闪引人注意（与节点树闪烁、
 * 精简模式 lite-attention-blink 同节奏：500ms 硬切换，亮 1 → 暗 0.2；
 * prefers-reduced-motion 下停用闪烁、保留常驻图标），hover 弹出提示说明
 * 待处理数量与完成方式；交互本身在节点树上完成（节点持续闪烁，点击节点打开锚定交互卡）。
 * 无待处理事项或处于对话/精简模式时整体不渲染。
 *
 * 三处标题栏共用本组件：WorkbenchDialog 内部标题栏（overlay 面），以及
 * Electron 原生窗 WindowFrame / 浏览器多窗 CyberWindow 的 title-actions——
 * 后两处 WorkbenchDialog 内部标题栏不渲染（isShellless），提示必须挂在外层。
 */
import { ElTooltip } from 'element-plus'
import { useWorkbenchAttentionCount } from './useWorkbenchAttentionCount'

const props = defineProps<{ windowId: string }>()
const count = useWorkbenchAttentionCount(() => props.windowId)
</script>

<template>
  <ElTooltip
    v-if="count > 0"
    placement="bottom"
    :show-after="120"
    :hide-after="0"
    :content="`${count} 项交互待处理，请在节点树上完成`"
  >
    <span
      class="workbench-attention-indicator"
      role="status"
      :aria-label="`${count} 项交互待处理，请在节点树上完成`"
    >
      ⚠
    </span>
  </ElTooltip>
</template>

<style scoped lang="less">
// 标题栏内的警示小方块：黄色系随主题（--nx-yellow 深浅主题各自取值）。
// 不可点击（无 cursor: pointer、无事件），hover 仅用于弹出 tip。
.workbench-attention-indicator {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid color-mix(in srgb, var(--nx-yellow) 48%, transparent);
  background: color-mix(in srgb, var(--nx-yellow) 16%, transparent);
  color: var(--nx-yellow);
  font-size: 14px;
  line-height: 1;
  cursor: default;
  user-select: none;
  // 持续硬闪提醒：与节点树闪烁环、精简模式 lite-attention-blink 同节奏
  // （500ms steps 硬切换，亮 1 → 暗 0.2），确认完成前不停。
  animation: workbench-attention-blink 500ms steps(1, end) infinite;
}
@keyframes workbench-attention-blink {
  0%,
  49% {
    opacity: 1;
  }
  50%,
  100% {
    opacity: 0.2;
  }
}
// 减弱动态偏好：停用闪烁，保留常驻图标本身（黄色警示配色不变）。
@media (prefers-reduced-motion: reduce) {
  .workbench-attention-indicator {
    animation: none;
  }
}
</style>
