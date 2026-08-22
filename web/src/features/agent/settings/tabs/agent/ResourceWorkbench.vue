<script setup lang="ts">
import { computed, watch } from 'vue'
import { Search } from '@element-plus/icons-vue'

export interface ResourceRailItem {
  key: string
  label: string
  avatar?: string
  /** vendor logo 图片 src（优先级高于 avatar 文本）。 */
  avatarIcon?: string
  /** 名字右侧紧贴显示（如 "128K"），与 label 同行的 <b> 之后。 */
  capacity?: string
  meta?: string
  badge?: string
  danger?: boolean
}

const props = withDefaults(
  defineProps<{
    items: ResourceRailItem[]
    modelValue?: string
    searchPlaceholder?: string
    glowRail?: boolean
  }>(),
  { modelValue: '', searchPlaceholder: '搜索资源', glowRail: false },
)
const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()
const search = defineModel<string>('search', { default: '' })

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return q
    ? props.items.filter((item) => `${item.label} ${item.meta ?? ''}`.toLowerCase().includes(q))
    : props.items
})

watch(
  () => props.items.map((item) => item.key).join('\0'),
  () => {
    if (!props.modelValue || !props.items.some((item) => item.key === props.modelValue)) {
      emit('update:modelValue', props.items[0]?.key ?? '')
    }
  },
  { immediate: true },
)
</script>

<template>
  <div class="resource-workbench" :class="{ 'glow-rail-enabled': glowRail }">
    <aside class="resource-rail">
      <div class="resource-rail-tools">
        <el-input v-model="search" clearable size="small" :placeholder="searchPlaceholder">
          <template #prefix><Search class="rail-search-icon" /></template>
        </el-input>
        <slot name="rail-actions" />
      </div>
      <div class="resource-rail-list" role="listbox">
        <button
          v-for="(item, i) in filtered"
          :key="item.key"
          type="button"
          class="resource-rail-card"
          :class="{ active: item.key === modelValue, danger: item.danger }"
          :style="{ '--rail-i': i }"
          :aria-selected="item.key === modelValue"
          @click="emit('update:modelValue', item.key)"
        >
          <span class="resource-avatar" aria-hidden="true">
            <img v-if="item.avatarIcon" :src="item.avatarIcon" :alt="item.label" class="avatar-img" />
            <template v-else>{{ item.avatar || item.label.slice(0, 1) }}</template>
          </span>
          <span class="resource-copy">
            <b>{{ item.label }}</b>
            <small v-if="item.meta || item.capacity" class="resource-meta">
              <span v-if="item.capacity" class="resource-capacity">{{ item.capacity }}</span>
              <span v-if="item.capacity && item.meta" class="resource-meta-sep">·</span>
              <span v-if="item.meta">{{ item.meta }}</span>
            </small>
          </span>
          <span v-if="item.badge" class="resource-badge">{{ item.badge }}</span>
        </button>
        <div v-if="!filtered.length" class="resource-rail-empty">没有匹配项</div>
      </div>
    </aside>
    <main class="resource-detail">
      <slot />
    </main>
  </div>
</template>

<style scoped lang="less">
@import '../../config/shared.less';
.resource-workbench {
  min-height: 0;
  height: 100%;
  display: grid;
  grid-template-columns: 190px minmax(0, 1fr);
  gap: 10px;
}
.resource-rail {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid rgba(129, 140, 248, 0.16);
  border-radius: 12px;
  background: linear-gradient(155deg, var(--surface-soft), var(--surface));
  backdrop-filter: blur(14px);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.66),
    0 8px 24px rgba(76, 29, 149, 0.055);
  overflow: hidden;
}
.resource-rail-tools {
  display: flex;
  gap: 5px;
  padding: 7px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
}
.resource-rail-list {
  min-height: 0;
  overflow-y: auto;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  // 滚动条跟随 tab 主题色（与 TabShell.shell-scroll 同款配色）
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--tab-color, @accent) 45%, transparent) transparent;
  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
  &::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--tab-color, @accent) 45%, transparent);
    border-radius: 3px;
  }
  &::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--tab-color, @accent) 70%, transparent);
  }
}
.resource-rail-card {
  position: relative;
  width: 100%;
  min-height: 48px;
  display: grid;
  grid-template-columns: 34px minmax(0, 1fr) auto;
  align-items: center;
  gap: 7px;
  padding: 5px 7px;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: color-mix(in srgb, var(--ink) 76%, transparent);
  text-align: left;
  cursor: pointer;
  transition:
    transform 0.16s ease,
    background-color 0.16s ease,
    color 0.16s ease;
}
.resource-rail-card::before {
  content: '';
  position: absolute;
  left: -6px;
  top: 50%;
  width: 4px;
  height: 16px;
  border-radius: 0 6px 6px 0;
  background: linear-gradient(180deg, #5ee7ff 0%, #6366f1 48%, #d946ef 100%);
  opacity: 0;
  transform: translate(-4px, -50%) scaleY(0.45);
  transition: 0.18s ease;
  box-shadow:
    0 0 5px #38bdf8,
    0 0 14px rgba(168, 85, 247, 0.65);
}
.resource-rail-card:hover {
  background: var(--surface-hover);
  transform: translateX(3px) rotate(-0.25deg);
}
.resource-rail-card:nth-child(even):hover {
  transform: translateX(3px) rotate(0.25deg);
}
.resource-rail-card.active {
  background: linear-gradient(
    90deg,
    rgba(59, 130, 246, 0.055),
    rgba(168, 85, 247, 0.035) 54%,
    transparent 84%
  );
  color: #4338ca;
}
.resource-rail-card.active::before {
  opacity: 1;
  transform: translate(0, -50%) scaleY(1);
  animation: rail-neon-ignite 0.5s ease-out;
}
.resource-rail-card.active .resource-avatar {
  transform: translateY(-2px) rotate(-3deg);
  border-color: rgba(96, 165, 250, 0.86);
  box-shadow:
    0 5px 12px rgba(49, 46, 129, 0.13),
    0 0 0 1px rgba(94, 234, 255, 0.45),
    0 0 8px rgba(56, 189, 248, 0.56),
    0 0 18px rgba(168, 85, 247, 0.32);
}
.resource-rail-card.active .resource-copy b {
  position: relative;
  color: #4338ca;
  text-shadow: 0 0 9px rgba(99, 102, 241, 0.3);
}
[data-theme='dark'] .resource-rail-card.active .resource-copy b {
  color: #a5b4fc;
}
.resource-rail-card.active .resource-copy b::after {
  content: '';
  position: absolute;
  left: 0;
  bottom: -3px;
  width: min(42px, 70%);
  height: 1px;
  border-radius: 2px;
  background: linear-gradient(90deg, #38bdf8, #818cf8, #d946ef, transparent);
  box-shadow: 0 0 6px rgba(99, 102, 241, 0.72);
  animation: rail-neon-trace 0.45s ease-out;
}
.resource-avatar {
  box-sizing: border-box;
  width: 32px;
  height: 32px;
  padding: 5px;
  display: grid;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
  border-radius: 11px 9px 12px 8px;
  background: linear-gradient(145deg, var(--surface), var(--surface-hover));
  box-shadow: 0 2px 7px color-mix(in srgb, var(--ink) 12%, transparent);
  font-size: 18px;
  transition: 0.18s cubic-bezier(0.2, 0.8, 0.2, 1);
  overflow: hidden;
}
.resource-avatar .avatar-img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  border-radius: inherit;
}
/* 大脑 vendor logo 多为深色图形，需恒定浅底才可见（不随主题翻转） */
.resource-avatar:has(.avatar-img) {
  background: linear-gradient(145deg, #ffffff, #f0ede6);
}
.resource-meta {
  display: flex;
  align-items: baseline;
  gap: 4px;
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.resource-meta > span {
  overflow: hidden;
  text-overflow: ellipsis;
}
.resource-capacity {
  font-weight: 400;
  color: color-mix(in srgb, var(--ink) 60%, transparent);
  flex-shrink: 0;
}
.resource-meta-sep {
  color: color-mix(in srgb, var(--ink) 30%, transparent);
  flex-shrink: 0;
}
.resource-copy {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.resource-copy b,
.resource-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.resource-copy b {
  font-size: 12px;
}
.resource-copy small {
  font-size: 10px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
}
.resource-badge {
  padding: 1px 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--tab-color, @accent) 20%, transparent);
  color: color-mix(in srgb, var(--tab-color, @accent) 75%, @ink);
  font-size: 9px;
  font-weight: 600;
}
.resource-detail {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding-right: 2px;
  // 滚动条跟随 tab 主题色（与 TabShell.shell-scroll 同款配色）
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--tab-color, @accent) 45%, transparent) transparent;
  &::-webkit-scrollbar {
    width: 6px;
  }
  &::-webkit-scrollbar-track {
    background: transparent;
  }
  &::-webkit-scrollbar-thumb {
    background: color-mix(in srgb, var(--tab-color, @accent) 45%, transparent);
    border-radius: 3px;
  }
  &::-webkit-scrollbar-thumb:hover {
    background: color-mix(in srgb, var(--tab-color, @accent) 70%, transparent);
  }
}
// glowRail（大脑/角色）：所有卡灯条常亮 + neon-hue 持续变色 + 三层 glow 扩散照亮右侧；active 卡强化。
// 每条灯条按 --rail-i 错开 animation-delay（负值），颜色不同步，节奏更有机。
.glow-rail-enabled .resource-rail-card::before {
  opacity: 0.5;
  transform: translate(0, -50%) scaleY(1);
  animation: neon-hue 6s linear infinite;
  animation-delay: calc(var(--rail-i, 0) * -0.9s);
  box-shadow:
    0 0 6px @neon-cyan,
    0 0 14px @neon-indigo,
    0 0 24px color-mix(in srgb, var(--neon-magenta) 28%, transparent);
}
.glow-rail-enabled .resource-rail-card.active::before {
  opacity: 1;
  box-shadow:
    0 0 9px @neon-cyan,
    0 0 22px @neon-indigo,
    0 0 38px color-mix(in srgb, var(--neon-magenta) 38%, transparent);
}
// 灯条漏光投射到右侧详情卡左缘
.glow-rail-enabled .resource-detail {
  box-shadow: inset 8px 0 24px -8px color-mix(in srgb, var(--neon-indigo) 22%, transparent);
}
.resource-rail-empty {
  padding: 24px 8px;
  text-align: center;
  font-size: 11px;
  color: color-mix(in srgb, var(--ink) 64%, transparent);
}
.rail-search-icon {
  width: 12px;
}
@media (max-width: 820px) {
  .resource-workbench {
    grid-template-columns: 72px minmax(0, 1fr);
  }
  .resource-copy,
  .resource-badge {
    display: none;
  }
  .resource-rail-tools :deep(.el-input__inner) {
    width: 0;
  }
  .resource-rail-card {
    grid-template-columns: 1fr;
    justify-items: center;
  }
}
@keyframes rail-neon-ignite {
  0% {
    opacity: 0.15;
    filter: brightness(0.7);
  }
  35% {
    opacity: 1;
    filter: brightness(1.8);
  }
  55% {
    opacity: 0.55;
  }
  100% {
    opacity: 1;
    filter: none;
  }
}
@keyframes rail-neon-trace {
  from {
    width: 0;
    opacity: 0.2;
  }
  to {
    width: min(42px, 70%);
    opacity: 1;
  }
}
</style>
