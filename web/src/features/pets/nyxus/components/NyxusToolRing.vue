<script setup lang="ts">
/**
 * NyxusToolRing：nyxus 独立核心的工具环子组件。
 * 含 2 个工具按钮（create/settings）+ PresetPicker + 雾化连线测量。
 * 发消息按钮已移除：双击 Nyxus 直接打开对话弹窗（AI 自动选择目标后可直接发送）。
 * 每帧测量按钮矩形 → setNyxusMenuTargets（驱动粒子雾化连线）；
 * 菜单启停时序（watch nyxusMenuOpen）+ onBeforeUnmount 清理在此自管。
 * 按钮点击通过 emit 上抛，由 NyxusCore host 执行实际 store 调用。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Moon, Plus, Setting, Sunny } from '@element-plus/icons-vue'
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
  dark: boolean
}>()

defineEmits<{
  'create-preset': [name: string]
  'create-fallback': []
  'open-settings': []
  'open-workbench': []
  'open-login': []
  'toggle-theme': []
}>()

const createButtonRef = ref<HTMLElement | null>(null)
const settingsButtonRef = ref<HTMLElement | null>(null)
const workbenchButtonRef = ref<HTMLElement | null>(null)
const loginButtonRef = ref<HTMLElement | null>(null)
const themeButtonRef = ref<HTMLElement | null>(null)
/** 是否有可创建的预设（PresetPicker 上报）；false → 隐藏 create 并将 settings 按单按钮居中。 */
const hasCreate = ref(false)
let toolTrackingRaf = 0

// 顶部上扇对称布点：奇数个 → 12 点(顶部)一个 + 两侧对称；偶数个 → 左右对称、无正中。
// 按实际可见按钮数自适应（全部预设已打开 → 仅剩 settings → 居中）。
const TOOL_RADIUS = 80
type ToolId = 'create' | 'settings' | 'workbench' | 'login' | 'theme'
const toolPositions = computed<Record<ToolId, { x: number; y: number }>>(() => {
  const ids: ToolId[] = hasCreate.value
    ? ['create', 'settings', 'workbench', 'login', 'theme']
    : ['settings', 'workbench', 'login', 'theme']
  const n = ids.length
  // 相邻按钮弧度上限 40°；超出上半圆(±90°)范围时按 40° 收拢，否则均分摊满上半圆。
  // 对称轴为 12 点(0°)：奇数 → 正中一个 + 两侧对称；偶数 → 左右对称、无正中；n=1 → 居中 0°。
  const STEP_MAX_DEG = 40
  const step = Math.min(STEP_MAX_DEG, 180 / (n - 1))
  const out: Record<ToolId, { x: number; y: number }> = {
    create: { x: 0, y: 0 },
    settings: { x: 0, y: 0 },
    workbench: { x: 0, y: 0 },
    login: { x: 0, y: 0 },
    theme: { x: 0, y: 0 },
  }
  ids.forEach((id, i) => {
    const angle = (i - (n - 1) / 2) * step
    const rad = (angle * Math.PI) / 180
    out[id] = {
      x: Math.round(TOOL_RADIUS * Math.sin(rad)),
      y: Math.round(-TOOL_RADIUS * Math.cos(rad)),
    }
  })
  return out
})
function toolStyle(pos: { x: number; y: number }): Record<string, string> {
  return { '--x': `${pos.x}px`, '--y': `${pos.y}px` }
}

function updateToolTargets(): void {
  const entries: Array<[NyxusMenuTarget['id'], HTMLElement | null]> = [
    ['create', hasCreate.value ? createButtonRef.value : null],
    ['settings', settingsButtonRef.value],
    ['workbench', workbenchButtonRef.value],
    ['login', loginButtonRef.value],
    ['theme', themeButtonRef.value],
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
      <span class="tool-slot tool-create" :style="toolStyle(toolPositions.create)" v-show="hasCreate">
        <PresetPicker
          :disabled="props.disabled"
          :excluded="props.excludedPresets"
          @pick="$emit('create-preset', $event)"
          @fallback="$emit('create-fallback')"
          @has-creatable="hasCreate = $event"
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
        ref="settingsButtonRef"
        type="button"
        class="ring-button tool-settings"
        :style="toolStyle(toolPositions.settings)"
        :disabled="!props.connected"
        aria-label="设置"
        @click="$emit('open-settings')"
        @pointerenter="highlightNyxusTool('settings')"
        @pointerleave="highlightNyxusTool(null)"
      >
        <Setting />
      </button>
      <button
        ref="workbenchButtonRef"
        type="button"
        class="ring-button tool-workbench"
        :style="toolStyle(toolPositions.workbench)"
        :disabled="!props.connected"
        aria-label="打开工作台"
        @click="$emit('open-workbench')"
        @pointerenter="highlightNyxusTool('workbench')"
        @pointerleave="highlightNyxusTool(null)"
      >
        🌳
      </button>
      <button
        ref="loginButtonRef"
        type="button"
        class="ring-button tool-login"
        :style="toolStyle(toolPositions.login)"
        aria-label="登录/连接服务"
        @click="$emit('open-login')"
        @pointerenter="highlightNyxusTool('login')"
        @pointerleave="highlightNyxusTool(null)"
      >
        🔑
      </button>
      <button
        ref="themeButtonRef"
        type="button"
        class="ring-button tool-theme"
        :style="toolStyle(toolPositions.theme)"
        :aria-label="props.dark ? '切换到浅色' : '切换到深色'"
        @click="$emit('toggle-theme')"
        @pointerenter="highlightNyxusTool('theme')"
        @pointerleave="highlightNyxusTool(null)"
      >
        <Sunny v-if="props.dark" />
        <Moon v-else />
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
  background: linear-gradient(135deg, rgba(255, 216, 130, 0.92), rgba(248, 190, 66, 0.86));
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.12),
    0 4px 12px rgba(0, 0, 0, 0.18);
  cursor: pointer;
  transition:
    transform 120ms steps(2, end),
    background 120ms linear,
    box-shadow 120ms linear;

  &:hover:not(:disabled) {
    color: #4a3008;
    background: linear-gradient(135deg, rgba(255, 233, 184, 0.98), rgba(255, 213, 122, 0.94));
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

// 深色主题：暗橙底 + 白色 icon（浅色主题默认已用亮底 + 深色 icon）
[data-theme='dark'] .ring-button {
  color: #fff;
  border-color: rgba(255, 245, 230, 0.2);
  background: linear-gradient(135deg, rgba(74, 52, 22, 0.92), rgba(48, 34, 15, 0.92));
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.08),
    0 4px 12px rgba(0, 0, 0, 0.4);
  &:hover:not(:disabled) {
    color: #fff;
    background: linear-gradient(135deg, rgba(104, 72, 30, 0.94), rgba(70, 49, 21, 0.94));
  }
}

// 位置由脚本 toolPositions 按「奇数顶部 12 点+对称 / 偶数左右对称」公式计算，经 --x/--y 注入。
// 此处仅保留基础定位与 create 内层 hover 覆盖（避免二次平移）。
.tool-slot,
.tool-settings,
.tool-workbench,
.tool-login,
.tool-theme {
  position: absolute;
  --x: 0px;
  --y: 0px;
  transform: translate(var(--x), var(--y));
}

.tool-create .ring-button {
  position: relative;
  // 内层 button 覆盖继承的 --x/--y，避免 hover translate 二次平移
  --x: 0px;
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
