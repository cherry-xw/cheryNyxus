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
  <span
    class="name"
    :class="{ 'is-master': isMaster, 'is-sub': isSub }"
    :title="nameChars.join('')"
  >
    <span
      v-if="isMaster && workspace"
      class="workspace-icon"
      :class="{ 'is-invalid': workspaceValid === false }"
      :aria-label="`工作区 ${workspaceFolder}`"
    >
      {{ workspaceIcon }}
      <span class="ws-bubble">{{ workspaceFolder }}</span>
    </span>
    <span class="name-text">
      <span v-for="(ch, i) in nameChars" :key="i" class="char">{{ ch }}</span>
    </span>
  </span>
</template>

<style scoped lang="less">
.name {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 58px;
  max-width: 126px;
  min-height: 20px;
  padding: 3px 8px;
  color: var(--pet-console-ink, var(--ink));
  font-size: 9px;
  font-weight: 700;
  line-height: 1.25;
  letter-spacing: 0.01em;
  white-space: nowrap;
}

.name-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.name.is-master .name-text {
  color: color-mix(in srgb, var(--pet-console-ink, var(--ink)) 78%, hsl(var(--tribe-hue) 66% 42%));
}

[data-theme='dark'] .name.is-master .name-text {
  color: color-mix(in srgb, var(--pet-console-ink, var(--ink)) 84%, hsl(var(--tribe-hue) 68% 72%));
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

  &.is-invalid {
    color: var(--danger);
  }

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

/* 运行配置已变更标记：名字右侧 ⚠，hover 弹失效项详情（brain/感官组缺失）。
   点击不可行（pet 单击已绑打开 AgentDialog）——仅提示，重选动作在 AgentDialog 内完成。 */
.runtime-badge {
  position: relative;
  display: inline-flex;
  align-items: center;
  margin-left: 3px;
  font-size: 9px;
  line-height: 1;
  color: var(--danger);
  cursor: default;
  user-select: none;

  &:hover .rt-bubble {
    display: block;
  }
}

.rt-bubble {
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
  border: 1px solid var(--danger);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.14);
  color: color-mix(in srgb, var(--danger) 88%, var(--ink));
  font-size: 9px;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  pointer-events: none;
  text-align: center;
  transform: translateX(-50%) scaleX(var(--pet-direction));
}
</style>
