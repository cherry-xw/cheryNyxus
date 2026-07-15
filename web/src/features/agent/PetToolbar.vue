<script setup lang="ts">
/**
 * PetToolbar：pet 工具栏按钮组，取代原 PetSprite 的装饰工具按钮（pet.tools）。
 * - 主 pet：历史 / 中止 / 销毁
 * - 子 pet：历史 / 中止
 * - ≥50% contextUsage 显 compact（预留，CP7 接 compact RPC）
 * - 中止按钮仅 isWorking 时渲染（避免常驻 disabled）
 * 中止/销毁/历史的具体调用由父（PetStage）处理，本组件仅 emit。
 */
import { computed } from "vue";
import type { PetInstance } from "@/features/pets/types";
import { useAgentsStore } from "@/stores";
import { collectDescendantChatIds } from "@/stores/agents/historyMerge";

const props = defineProps<{
  pet: PetInstance;
}>();

const emit = defineEmits<{
  history: [pet: PetInstance];
  abort: [pet: PetInstance];
  destroy: [pet: PetInstance];
  compact: [pet: PetInstance];
  resume: [pet: PetInstance];
}>();

const agents = useAgentsStore();

const showCompact = computed(() => props.pet.contextUsage >= 0.5);
/** 主 pet idle 且末条为未完成周期 → 显"继续"按钮，用户点击触发 chat.resume */
const showResume = computed(() => props.pet.isMaster && !props.pet.isWorking && !!props.pet.canResume);

/**
 * CP8：destroy(=隐藏) 可用性。运行中（pet.isWorking 或任一后代 pet isWorking）禁用——
 * 避免隐藏运行中 pet 致孤儿流（无视觉但 stream 仍在写）。
 */
const canHide = computed(() => {
  if (props.pet.isWorking) return false;
  const descendants = new Set(collectDescendantChatIds(agents.pets, props.pet.chatId));
  return !agents.pets.some((p) => descendants.has(p.chatId) && p.isWorking);
});
</script>

<template>
  <div class="pet-toolbar" @pointerdown.stop @click.stop>
    <button
      v-if="showCompact"
      type="button"
      class="tool-btn compact"
      aria-label="Compact context"
      @click="emit('compact', pet)"
    >
      ⊛<span class="tip">Compact</span>
    </button>
    <button
      type="button"
      class="tool-btn"
      aria-label="History"
      @click="emit('history', pet)"
    >
      🕐<span class="tip">History</span>
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
</style>
