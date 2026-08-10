<script setup lang="ts">
/**
 * ThinkingLevelStep：思考强度档位选择器（step 线 + 变色）。
 * 4 档：off（关闭）/ low（低）/ medium（中）/ high（高），越往后强度越高、颜色越深越暖。
 * 绑定 ThinkingLevel（v-model），用于 BrainCard 的「深度思考」控件。
 * 样式对齐 settings/shared.less 金色系（#ffd27a / #f6b73c / #d99717）。
 *
 * 交互：点击选档；键盘 ArrowLeft/Right/Up/Down + 数字键 0-3 快捷；radiogroup 语义。
 */
import { computed } from 'vue'
import type { ThinkingLevel } from '@/services/agentApi'

const model = defineModel<ThinkingLevel>({ default: 'off' })

interface LevelOption {
  value: ThinkingLevel
  label: string
  /** 前景色（文字/激活态） */
  color: string
  /** 背景色（激活态填充） */
  bg: string
}

const LEVELS: LevelOption[] = [
  {
    value: 'off',
    label: '关闭',
    color: 'color-mix(in srgb, var(--ink) 62%, transparent)',
    bg: 'color-mix(in srgb, var(--ink) 10%, transparent)',
  },
  { value: 'low', label: '低', color: '#9a6b14', bg: '#ffd27a' },
  { value: 'medium', label: '中', color: '#7a4d0e', bg: '#f6b73c' },
  { value: 'high', label: '高', color: '#fff7e6', bg: '#d99717' },
]

const activeIndex = computed(() => LEVELS.findIndex((l) => l.value === model.value))

function select(level: ThinkingLevel): void {
  model.value = level
}

function onKeydown(e: KeyboardEvent): void {
  const cur = activeIndex.value < 0 ? 0 : activeIndex.value
  if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
    e.preventDefault()
    select(LEVELS[Math.min(LEVELS.length - 1, cur + 1)]!.value)
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
    e.preventDefault()
    select(LEVELS[Math.max(0, cur - 1)]!.value)
  } else if (/^[0-3]$/.test(e.key)) {
    e.preventDefault()
    select(LEVELS[Number(e.key)]!.value)
  }
}
</script>

<template>
  <div
    class="thinking-step"
    role="radiogroup"
    aria-label="思考强度"
    tabindex="0"
    @keydown="onKeydown"
  >
    <button
      v-for="(lvl, i) in LEVELS"
      :key="lvl.value"
      type="button"
      class="step-pill"
      :class="{ filled: i <= activeIndex, current: i === activeIndex }"
      :style="i <= activeIndex ? { '--pill-bg': lvl.bg, '--pill-color': lvl.color } : {}"
      :aria-checked="i === activeIndex"
      role="radio"
      :aria-label="lvl.label"
      @click="select(lvl.value)"
    >
      <span class="pill-dot" />
      <span class="pill-label">{{ lvl.label }}</span>
    </button>
  </div>
</template>

<style scoped lang="less">
@import '../../config/shared.less';

.thinking-step {
  display: flex;
  gap: 3px;
  width: 100%;
  padding: 2px;
  outline: none;

  &:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent);
    border-radius: 7px;
  }
}

.step-pill {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 4px 2px;
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-radius: 6px;
  background: var(--surface-soft);
  cursor: pointer;
  font-family: inherit;
  font-size: 11px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  transition:
    background 0.18s ease,
    color 0.18s ease,
    border-color 0.18s ease,
    transform 0.1s ease;

  .pill-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: color-mix(in srgb, var(--ink) 22%, transparent);
    transition: background 0.18s ease;
    flex-shrink: 0;
  }

  .pill-label {
    line-height: 1;
    font-weight: 600;
  }

  // 选中档位及其左侧（i <= activeIndex）：填充对应档色，形成 step 进度
  &.filled {
    background: var(--pill-bg);
    border-color: transparent;
    color: var(--pill-color);

    .pill-dot {
      background: var(--pill-color);
    }
  }

  // 当前档（精确选中）：强调描边
  &.current {
    transform: translateY(-1px);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12);
    font-weight: 800;
  }

  &:hover {
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
  }
}
</style>
