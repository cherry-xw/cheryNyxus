<script setup lang="ts">
/**
 * ThinkingTrigger：思考按钮 + flyout（content 气泡左外侧 🤔 icon，hover 显思考框）。
 * 从 PetBubbles.work-bubble 拆出。绝对定位锚定到最近 positioned 祖先（.speech 气泡）。
 */
defineProps<{
  displayThinking: string
}>()
</script>

<template>
  <div class="thinking-trigger" aria-label="查看思考过程">
    <span class="thinking-icon" aria-hidden="true">🤔</span>
    <div class="thinking-flyout" role="tooltip">{{ displayThinking }}</div>
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);

/* thinking 按钮：思考结束后锚 content 气泡左外侧（emoji icon）；hover 向左上拉伸显思考框（盖住按钮），
   鼠标移开 scale(0) 缩回恢复 icon。emoji 黄脸（🤔）作按钮。 */
.thinking-trigger {
  position: absolute;
  right: 100%; /* content 气泡左外侧 */
  bottom: -1px; /* 贴气泡左下角外侧 */
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  line-height: 1;
  cursor: default;
  user-select: none;

  .thinking-icon {
    font-size: 13px;
    filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.15));
    transition: transform 140ms ease;
  }

  &:hover .thinking-icon {
    transform: scale(1.15);
  }

  &:hover .thinking-flyout {
    transform: scale(1);
    opacity: 1;
    pointer-events: auto;
  }
}

.thinking-flyout {
  position: absolute;
  right: 0; /* 右沿对齐按钮（= 气泡左沿），向左拉伸 */
  bottom: 0; /* 底对齐按钮，向上拉伸 */
  z-index: 30;
  box-sizing: border-box;
  width: 200px;
  max-height: 150px;
  padding: 5px 7px;
  border-radius: 7px;
  border: 1px dashed color-mix(in srgb, var(--neon-indigo) 40%, transparent);
  background: var(--panel);
  box-shadow: 0 6px 14px rgba(0, 0, 0, 0.14);
  color: color-mix(in srgb, var(--ink) 64%, transparent);
  font-size: 9.5px;
  font-weight: 400;
  font-style: italic;
  line-height: 1.4;
  white-space: pre-wrap;
  overflow: auto;
  text-align: left;
  transform: scale(0); /* 收起：缩成右下角点；hover scale(1) 向左上拉伸展开盖住按钮 */
  transform-origin: bottom right;
  opacity: 0;
  pointer-events: none;
  transition:
    transform 180ms ease,
    opacity 140ms ease;
}
</style>
