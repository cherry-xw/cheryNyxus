<script setup lang="ts">
/**
 * PetToolbar：pet 工具栏按钮组，取代原 PetSprite 的装饰工具按钮（pet.tools）。
 * - 主 pet：历史 / 中止 / 销毁
 * - 子 pet：历史 / 中止
 * - >40% contextUsage 显 compact，点击直接发送内置 /compact 指令
 * - 中止按钮仅 isWorking 时渲染（避免常驻 disabled）
 * 中止/销毁/历史的具体调用由父（PetStage）处理，本组件仅 emit。
 */
import { computed } from 'vue'
import type { PetInstance } from '@/features/pets/types/types'
import { useAgentsStore } from '@/stores'
import { collectDescendantChatIds } from '@/stores/agents/historyMerge'

const CLOCK_EMOJIS = [
  '🕐',
  '🕑',
  '🕒',
  '🕓',
  '🕔',
  '🕕',
  '🕖',
  '🕗',
  '🕘',
  '🕙',
  '🕚',
  '🕛',
  '🕜',
  '🕝',
  '🕞',
  '🕟',
  '🕠',
  '🕡',
  '🕢',
  '🕣',
  '🕤',
  '🕥',
  '🕦',
  '🕧',
] as const

const props = defineProps<{
  pet: PetInstance
}>()

const emit = defineEmits<{
  history: [pet: PetInstance]
  abort: [pet: PetInstance]
  destroy: [pet: PetInstance]
  compact: [pet: PetInstance]
  resume: [pet: PetInstance]
}>()

const agents = useAgentsStore()

/**
 * 阈值命中（与后端 thresholdReached 同语义）：
 * percent → used/total ≥ value；tokens → used ≥ value。total ≤ 0 → false。
 */
function thresholdReached(
  t: { unit: 'tokens' | 'percent'; value: number } | undefined,
  used: number,
  total: number,
): boolean {
  if (!t || total <= 0) return false
  return t.unit === 'percent' ? used / total >= t.value : used >= t.value
}

/** compact 可用门槛：brain 容量 ≥ minContextLimit（无开关；默认展示只关联默认 brain 上下文）。 */
const compactAvailable = computed(() => {
  const cc = props.pet.commandConfig
  const total = props.pet.contextTotal
  if (!total || total <= 0) return false
  const minLimit = cc?.minContextLimit ?? 0
  return !(minLimit > 0 && total < minLimit)
})

/**
 * 显示条件（全部满足才显）：
 * - compact 可用（brain「够大」）
 * - contextUsage ≥ warn（到达提示阈值才显按钮；warn 缺省按 0.6 兜底，对齐后端默认）
 */
const showCompact = computed(() => {
  if (!compactAvailable.value) return false
  const cc = props.pet.commandConfig
  const warn = cc?.warn ?? { unit: 'percent' as const, value: 0.6 }
  return thresholdReached(warn, props.pet.contextUsed, props.pet.contextTotal)
})

/** usage ≥ auto → 强提示（按钮高亮脉冲）；后端此时会自动压缩。 */
const compactUrgent = computed(() => {
  const cc = props.pet.commandConfig
  if (!cc) return false
  return thresholdReached(cc.auto, props.pet.contextUsed, props.pet.contextTotal)
})
/** 主 pet idle 且末条为未完成周期 → 显"继续"按钮，用户点击触发 chat.resume */
const showResume = computed(
  () => props.pet.isMaster && !props.pet.isWorking && !!props.pet.canResume,
)

/**
 * CP8：destroy(=隐藏) 可用性。运行中（pet.isWorking 或任一后代 pet isWorking）禁用——
 * 避免隐藏运行中 pet 致孤儿流（无视觉但 stream 仍在写）。
 */
const canHide = computed(() => {
  if (props.pet.isWorking) return false
  const descendants = new Set(collectDescendantChatIds(agents.pets, props.pet.chatId))
  return !agents.pets.some((p) => descendants.has(p.chatId) && p.isWorking)
})
</script>

<template>
  <div class="pet-toolbar" @pointerdown.stop @click.stop>
    <button
      v-if="showCompact"
      type="button"
      class="tool-btn compact"
      :class="{ urgent: compactUrgent }"
      aria-label="Compact context"
      @click="emit('compact', pet)"
    >
      ⊛<span class="tip">Compact</span>
    </button>
    <button type="button" class="tool-btn" aria-label="History" @click="emit('history', pet)">
      <span v-if="pet.isWorking" class="clock-strip" aria-hidden="true">
        <span class="clock-track">
          <span v-for="(c, i) in CLOCK_EMOJIS" :key="i" class="clock-frame">{{ c }}</span>
        </span>
      </span>
      <span v-else aria-hidden="true">🕐</span>
      <span class="tip">History</span>
    </button>
    <button
      v-if="pet.isWorking"
      type="button"
      class="tool-btn"
      aria-label="Abort"
      @click="emit('abort', pet)"
    >
      ⏹<span class="tip">Abort</span>
    </button>
    <button
      v-if="showResume"
      type="button"
      class="tool-btn resume"
      aria-label="Resume"
      @click="emit('resume', pet)"
    >
      ▶<span class="tip">继续</span>
    </button>
    <button
      v-if="pet.isMaster"
      type="button"
      class="tool-btn danger"
      aria-label="隐藏"
      :disabled="!canHide"
      @click="emit('destroy', pet)"
    >
      ✕<span class="tip">隐藏</span>
    </button>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.pet-toolbar {
  display: inline-flex;
  align-items: center;
  gap: 2px;
}

.tool-btn {
  position: relative;
  width: 16px;
  height: 16px;
  padding: 0;
  border: 1px solid rgba(36, 38, 45, 0.16);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.82);
  color: #24262d;
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
  cursor: pointer;
  overflow: visible;

  &:hover {
    background: #ffffff;
  }

  &:disabled {
    color: fade(@ink, 32%);
    background: rgba(255, 255, 255, 0.5);
    cursor: not-allowed;

    &:hover {
      background: rgba(255, 255, 255, 0.5);
    }

    .tip {
      display: none;
    }
  }

  &.compact {
    background: rgba(255, 196, 87, 0.4);
  }

  &.compact.urgent {
    background: rgba(248, 113, 113, 0.55);
    color: #7f1d1d;
    animation: compact-pulse 1.1s ease-in-out infinite;
  }

  &.resume {
    background: rgba(74, 222, 128, 0.4);
    color: #15803d;
  }

  &.danger {
    color: #b91c1c;

    &:hover {
      background: #fee2e2;
    }
  }

  .tip {
    position: absolute;
    z-index: 5;
    bottom: 130%;
    left: 50%;
    transform: translateX(-50%) scale(0.9);
    padding: 3px 7px;
    border-radius: 5px;
    background: fade(@ink, 90%);
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    line-height: 1.2;
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition:
      opacity 150ms ease,
      transform 150ms ease;
  }

  &:hover .tip {
    opacity: 1;
    transform: translateX(-50%) scale(1);
  }
}

.clock-strip {
  display: inline-block;
  width: 16px;
  height: 16px;
  overflow: hidden;
  line-height: 1;
  vertical-align: middle;
}

.clock-track {
  display: inline-flex;
  width: 384px;
  height: 16px;
  animation: clock-slide 2.4s steps(24) infinite;
}

.clock-frame {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

@keyframes clock-slide {
  from {
    transform: translateX(0);
  }
  to {
    transform: translateX(-384px);
  }
}

@keyframes compact-pulse {
  0%,
  100% {
    transform: scale(1);
  }
  50% {
    transform: scale(1.18);
  }
}
</style>
