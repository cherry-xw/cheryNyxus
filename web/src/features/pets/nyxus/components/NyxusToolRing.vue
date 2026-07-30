<script setup lang="ts">
/**
 * NyxusToolRing：nyxus 独立核心的工具环子组件。
 * 含 4 个工具按钮（create/chat/history/settings）+ PresetPicker + 雾化连线测量。
 * 每帧测量按钮矩形 → setNyxusMenuTargets（驱动粒子雾化连线）；
 * 菜单启停时序（watch nyxusMenuOpen）+ onBeforeUnmount 清理在此自管。
 * 按钮点击通过 emit 上抛，由 NyxusCore host 执行实际 store 调用。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ChatDotRound, Clock, Plus, Setting } from '@element-plus/icons-vue'
import PresetPicker from '@/features/agent/toolbar/PresetPicker.vue'
import {
  highlightNyxusTool,
  nyxusMenuOpen,
  setNyxusMenuTargets,
  type NyxusMenuTarget,
} from '../nyxusUiState'

const props = defineProps<{
  disabled: boolean
  connected: boolean
  excludedPresets: string[]
}>()

defineEmits<{
  'create-preset': [name: string]
  'create-fallback': []
  'open-chat': []
  'open-history': []
  'open-settings': []
}>()

const createButtonRef = ref<HTMLElement | null>(null)
const chatButtonRef = ref<HTMLElement | null>(null)
const historyButtonRef = ref<HTMLElement | null>(null)
const settingsButtonRef = ref<HTMLElement | null>(null)
let toolTrackingRaf = 0

function updateToolTargets(): void {
  const entries: Array<[NyxusMenuTarget['id'], HTMLElement | null]> = [
    ['create', createButtonRef.value],
    ['chat', chatButtonRef.value],
    ['history', historyButtonRef.value],
    ['settings', settingsButtonRef.value],
  ]
  const targets = entries.flatMap<NyxusMenuTarget>(([id, element]) => {
    if (!element) return []
    const rect = element.getBoundingClientRect()
    return [{ id, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }]
  })
  setNyxusMenuTargets(targets)
  toolTrackingRaf = requestAnimationFrame(updateToolTargets)
}

watch(
  nyxusMenuOpen,
  async (open) => {
    cancelAnimationFrame(toolTrackingRaf)
    toolTrackingRaf = 0
    if (!open) {
      setNyxusMenuTargets([])
      highlightNyxusTool(null)
      return
    }
    await nextTick()
    updateToolTargets()
  },
  { flush: 'post' },
)

onBeforeUnmount(() => {
  cancelAnimationFrame(toolTrackingRaf)
  setNyxusMenuTargets([])
  highlightNyxusTool(null)
})
</script>

<template>
  <transition name="ring">
    <div v-if="nyxusMenuOpen" class="tool-ring">
      <span class="tool-slot tool-create">
        <PresetPicker
          :disabled="props.disabled"
          :excluded="props.excludedPresets"
          @pick="$emit('create-preset', $event)"
          @fallback="$emit('create-fallback')"
        >
          <button
            ref="createButtonRef"
            type="button"
            class="ring-button"
            :disabled="props.disabled"
            aria-label="创建预设宠物"
            @pointerenter="highlightNyxusTool('create')"
            @pointerleave="highlightNyxusTool(null)"
          >
            <Plus />
          </button>
        </PresetPicker>
      </span>
      <button
        ref="historyButtonRef"
        type="button"
        class="ring-button tool-history"
        :disabled="!props.connected"
        aria-label="历史会话"
        @click="$emit('open-history')"
        @pointerenter="highlightNyxusTool('history')"
        @pointerleave="highlightNyxusTool(null)"
      >
        <Clock />
      </button>
      <button
        ref="settingsButtonRef"
        type="button"
        class="ring-button tool-settings"
        :disabled="!props.connected"
        aria-label="设置"
        @click="$emit('open-settings')"
        @pointerenter="highlightNyxusTool('settings')"
        @pointerleave="highlightNyxusTool(null)"
      >
        <Setting />
      </button>
      <button
        ref="chatButtonRef"
        type="button"
        class="ring-button tool-chat"
        :disabled="props.disabled"
        aria-label="与 cheryNyxus 对话"
        @click="$emit('open-chat')"
        @pointerenter="highlightNyxusTool('chat')"
        @pointerleave="highlightNyxusTool(null)"
      >
        <ChatDotRound />
      </button>
    </div>
  </transition>
</template>

<style scoped lang="less">
.tool-ring {
  position: absolute;
  // 按钮的定位点是左上角；回移半径后，四个按钮的圆心才与 Nyxus 核心共用锚点。
  left: -13px;
  top: -13px;
  z-index: 5;
  width: 1px;
  height: 1px;
  pointer-events: auto;
}

.ring-button {
  position: absolute;
  display: grid;
  place-items: center;
  width: 26px;
  height: 26px;
  padding: 4px;
  // 虚化毛玻璃：半透明暖橙底 + backdrop blur；边框柔白低强度；软阴影替硬环
  border: 1px solid rgba(255, 245, 230, 0.32);
  border-radius: 50%;
  color: #3d2606;
  background: linear-gradient(135deg, rgba(255, 210, 122, 0.42), rgba(246, 183, 60, 0.3));
  backdrop-filter: blur(6px) saturate(1.15);
  -webkit-backdrop-filter: blur(6px) saturate(1.15);
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.12),
    0 4px 12px rgba(0, 0, 0, 0.18);
  cursor: pointer;
  transition:
    transform 120ms steps(2, end),
    background 120ms linear,
    box-shadow 120ms linear;

  &:hover:not(:disabled) {
    color: #5a3d0a;
    background: linear-gradient(135deg, rgba(255, 233, 184, 0.68), rgba(255, 210, 122, 0.52));
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.24),
      0 6px 16px rgba(0, 0, 0, 0.22);
    // 定位 translate 由外层 modifier 注入 --x/--y，hover 在其上叠加 scale
    transform: translate(var(--x, 0px), var(--y, 0px)) scale(1.12);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }

  svg {
    width: 14px;
    height: 14px;
  }
}

// 4 按钮上半圆均布（半径 64px，角度 180°/240°/300°/360°，y 向下故负 y 朝上）
// create=180°(-64,0) history=240°(-32,-55) settings=300°(32,-55) chat=360°(64,0)
.tool-slot,
.tool-history,
.tool-settings,
.tool-chat {
  position: absolute;
  --x: 0px;
  --y: 0px;
  transform: translate(var(--x), var(--y));
}

.tool-create {
  --x: -64px;
  --y: 0px;
}

.tool-create .ring-button {
  position: relative;
  // 内层 button 覆盖继承的 --x/--y，避免 hover translate 二次平移
  --x: 0px;
  --y: 0px;
}

.tool-history {
  --x: -32px;
  --y: -55px;
}

.tool-settings {
  --x: 32px;
  --y: -55px;
}

.tool-chat {
  --x: 64px;
  --y: 0px;
}

.ring-enter-active,
.ring-leave-active {
  transition:
    opacity 120ms linear,
    transform 180ms steps(3, end);
}

.ring-enter-from,
.ring-leave-to {
  opacity: 0;
  transform: scale(0.45) rotate(-16deg);
}
</style>
