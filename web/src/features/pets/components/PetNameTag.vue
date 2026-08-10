<script setup lang="ts">
/**
 * PetNameTag：宠物名字标签（含 workspace icon + ws-bubble + per-char 彩虹）。
 * 从 PetBody 拆出（纯展示）。workspaceFolder/workspaceIcon computed 留在父组件，结果作 prop 传入。
 * tribe 色由 CSS var --tribe-hue 提供（DOM 继承）；朝向由 --pet-direction 提供。
 */
defineProps<{
  nameChars: string[]
  isMaster: boolean
  isSub: boolean
  workspace?: string
  workspaceValid?: boolean
  workspaceFolder: string
  workspaceIcon: string
}>()
</script>

<template>
  <span class="name" :class="{ 'is-master': isMaster, 'is-sub': isSub }">
    <span
      v-if="isMaster && workspace"
      class="workspace-icon"
      :class="{ 'is-invalid': workspaceValid === false }"
      :aria-label="`工作区 ${workspaceFolder}`"
    >
      {{ workspaceIcon }}
      <span class="ws-bubble">{{ workspaceFolder }}</span>
    </span>
    <span v-for="(ch, i) in nameChars" :key="i" class="char" :style="{ '--char-i': i }">{{
      ch
    }}</span>
  </span>
</template>

<style scoped lang="less">
@ink: var(--ink);
@tribe-border: hsl(var(--tribe-hue) 60% 55%);
@tribe-bg: hsl(var(--tribe-hue) 58% 92%);
@tribe-ink: hsl(var(--tribe-hue) 50% 26%);

.name {
  padding: 1px 5px;
  border: 1px solid var(--border);
  border-radius: 999px;
  // 不透明底（panel），避免半透明白/黑导致名字与上层信息看不清
  background: var(--panel);
  color: color-mix(in srgb, var(--ink) 72%, transparent);
  font-size: 8px;
  font-weight: 400;
  line-height: 1.2;
  white-space: nowrap;
}

.name.is-master {
  border-color: @tribe-border;
  background: @tribe-bg;
  color: @tribe-ink;
  .char {
    color: hsl(0 85% 55%);
    animation: rainbow-char 3s linear infinite;
    animation-delay: calc(var(--char-i, 0) * 0.2s);
  }
}

.name.is-sub {
  border-color: @tribe-border;
  background: @tribe-bg;
  color: @tribe-ink;
}

// 深色：tribe 牌换深底浅字，避免浅黄牌在深底刺眼
[data-theme='dark'] .name.is-master,
[data-theme='dark'] .name.is-sub {
  border-color: hsl(var(--tribe-hue) 50% 55%);
  background: hsl(var(--tribe-hue) 42% 20%);
  color: hsl(var(--tribe-hue) 55% 88%);
}

/* 工作区 icon：meta-row name 前，pet 带 workspace 时显。hover 弹 basename（最后一层文件夹名）。
   呼应 AgentDialog 工作区提示（📁/⚠），icon 改 🖥️/💢 以区分桌面端工作区语义。 */
.workspace-icon {
  position: relative;
  display: inline-flex;
  align-items: center;
  margin-right: 2px;
  font-size: 10px;
  line-height: 1;
  vertical-align: middle;
  cursor: default;
  user-select: none;

  &:hover .ws-bubble {
    display: block;
  }
}

.ws-bubble {
  display: none;
  position: absolute;
  bottom: 100%;
  left: 50%;
  z-index: 20;
  box-sizing: border-box;
  width: max-content;
  max-width: 160px;
  margin-bottom: 4px;
  padding: 3px 6px;
  border-radius: 5px;
  background: var(--panel);
  border: 1px solid var(--border);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.14);
  color: color-mix(in srgb, var(--ink) 84%, transparent);
  font-size: 9px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  pointer-events: none;
  text-align: center;
  /* meta-row 有 scaleX(direction)；bubble 反向 scaleX 抵消，避免 pet 朝左时文字镜像 */
  transform: translateX(-50%) scaleX(var(--pet-direction));
}

@keyframes rainbow-char {
  0% {
    color: hsl(0 85% 55%);
  }
  17% {
    color: hsl(60 85% 55%);
  }
  33% {
    color: hsl(120 85% 55%);
  }
  50% {
    color: hsl(180 85% 55%);
  }
  67% {
    color: hsl(240 85% 55%);
  }
  83% {
    color: hsl(300 85% 55%);
  }
  100% {
    color: hsl(360 85% 55%);
  }
}
</style>
