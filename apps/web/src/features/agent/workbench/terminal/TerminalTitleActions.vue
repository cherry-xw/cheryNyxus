<script setup lang="ts">
/**
 * TerminalTitleActions：独立终端窗标题栏右侧动作区。
 *
 * 渲染连接信息、连接状态按钮（lucide Link/Unlink 成对图标）与清空按钮：
 * - 已连接：Link 图标 + 「已连接」，点第一下文字变为「确认断开？」，点第二下才主动断开（发送 exit）；
 * - 连接中：Link 图标 + 「连接中」，静态展示；
 * - 未连接/已断开：Unlink 图标 + 「重连」，点击直接重连当前预设。
 *
 * 样式类由 App.vue 全局样式区提供（与 title-actions 空白穿透、原生 no-drag 规则配套）。
 */
import { computed, ref, watch } from 'vue'
import { MorphIcon, type IconInput } from 'morphicons/vue'
import { Link, Unlink } from 'lucide'
import { useMotionTier } from '@/composables/useMotionTier'
import type { TerminalHeaderMeta } from './WorkbenchTerminal.vue'

const props = defineProps<{ meta: TerminalHeaderMeta }>()
const emit = defineEmits<{ connect: []; disconnect: []; clear: [] }>()

const { spec } = useMotionTier()
const reducedMotion = computed(() =>
  spec.value.mode === 'full' && spec.value.decoration !== 'off' ? 'user' : 'always',
)

/** 未连接（idle）/已断开（exited）→ 显示可点击的「重连」按钮。 */
const disconnected = computed(() => props.meta.status === 'idle' || props.meta.status === 'exited')

/** 已连接二次确认：点第一下进入「确认断开？」文本态，点第二下才真正断开；确认态保持到第二下或状态变化。 */
const confirming = ref(false)
function onConnectedClick(): void {
  if (!confirming.value) {
    confirming.value = true
    return
  }
  confirming.value = false
  emit('disconnect')
}
watch(
  () => props.meta.status,
  (status) => {
    if (status !== 'connected') confirming.value = false
  },
)

const label = computed(() => {
  if (props.meta.status === 'connected' && confirming.value) return '确认断开？'
  return { idle: '重连', connecting: '连接中', connected: '已连接', exited: '重连' }[
    props.meta.status
  ]
})
const icon = computed<IconInput>(() => (disconnected.value ? Unlink : Link))
</script>

<template>
  <span v-if="meta.username || meta.host" class="terminal-title-connection">
    {{ meta.username }} · {{ meta.host }}
  </span>

  <button
    v-if="meta.status === 'connected'"
    type="button"
    class="terminal-title-state is-connected"
    :class="{ 'is-confirming': confirming }"
    @click="onConnectedClick"
  >
    <MorphIcon
      :icon="icon"
      :size="12"
      :stroke-width="1.8"
      :reduced-motion="reducedMotion"
      aria-hidden="true"
    />
    {{ label }}
  </button>

  <button
    v-else-if="disconnected"
    type="button"
    class="terminal-title-state is-reconnect"
    @click="emit('connect')"
  >
    <MorphIcon
      :icon="icon"
      :size="12"
      :stroke-width="1.8"
      :reduced-motion="reducedMotion"
      aria-hidden="true"
    />
    {{ label }}
  </button>

  <span v-else class="terminal-title-state is-connecting">
    <MorphIcon
      :icon="icon"
      :size="12"
      :stroke-width="1.8"
      :reduced-motion="reducedMotion"
      aria-hidden="true"
    />
    {{ label }}
  </span>

  <button type="button" class="terminal-title-clear" @click="emit('clear')">清空</button>
</template>
