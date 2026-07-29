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
      <el-tooltip content="创建预设宠物" placement="left">
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
      </el-tooltip>
      <el-tooltip content="历史会话" placement="top">
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
      </el-tooltip>
      <el-tooltip content="设置" placement="right">
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
      </el-tooltip>
      <el-tooltip content="与 cheryNyxus 对话" placement="bottom">
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
      </el-tooltip>
    </div>
  </transition>
</template>

<style scoped lang="less">
.tool-ring {
  position: absolute;
  left: 0;
  top: 0;
  z-index: 5;
  width: 1px;
  height: 1px;
  pointer-events: auto;
}

.ring-button {
  position: absolute;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  padding: 8px;
  border: 1px solid rgba(120, 231, 255, 0.72);
  border-radius: 50%;
  color: #e0ffff;
  background: #202432;
  box-shadow:
    0 0 0 2px rgba(16, 18, 29, 0.7),
    0 5px 14px rgba(0, 0, 0, 0.28);
  cursor: pointer;
  transition:
    transform 120ms steps(2, end),
    background 120ms linear;

  &:hover:not(:disabled) {
    color: #15212a;
    background: #8ef2ff;
    transform: scale(1.12);
  }

  &:disabled {
    cursor: not-allowed;
    opacity: 0.42;
  }

  svg {
    width: 20px;
    height: 20px;
  }
}

.tool-slot,
.tool-history,
.tool-settings,
.tool-chat {
  position: absolute;
}

.tool-create {
  left: -76px;
  top: -22px;
}

.tool-create .ring-button {
  position: relative;
}

.tool-history {
  left: -19px;
  top: -78px;
}

.tool-settings {
  left: 38px;
  top: -22px;
}

.tool-chat {
  left: -19px;
  top: 40px;
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
