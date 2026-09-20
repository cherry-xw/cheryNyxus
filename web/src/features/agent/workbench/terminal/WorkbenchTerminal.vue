<script setup lang="ts">
import '@xterm/xterm/css/xterm.css'
import { ref, watch } from 'vue'
import { useAgentsStore } from '@/application/public'
import { useWorkbenchTerminal } from './useWorkbenchTerminal'

export interface TerminalHeaderMeta {
  username: string
  host: string
  status: 'idle' | 'connecting' | 'connected' | 'exited'
}

const props = defineProps<{ chatId: string; initialPresetId?: string; autoConnect?: boolean }>()
const emit = defineEmits<{ title: [value: string]; meta: [value: TerminalHeaderMeta] }>()
const agents = useAgentsStore()
const {
  host,
  status,
  error,
  label,
  presets,
  selectedPresetId,
  canConnect,
  applyPreset,
  connect,
  clear,
} = useWorkbenchTerminal(() => props.chatId)

watch(label, (value) => emit('title', value || 'Terminal'), { immediate: true })
watch(
  [label, status, selectedPresetId, presets],
  () => {
    const preset = presets.value.find((item) => item.id === selectedPresetId.value)
    emit('meta', {
      username: preset?.username ?? '',
      host: preset?.host ?? '',
      status: status.value,
    })
  },
  { immediate: true, deep: true },
)
const autoConnected = ref(false)
watch(
  [presets, () => props.initialPresetId],
  ([items, presetId]) => {
    if (!props.autoConnect || autoConnected.value || !presetId || !items.some((item) => item.id === presetId)) return
    applyPreset(presetId)
    autoConnected.value = true
    void connect()
  },
  { immediate: true },
)

function openSettings(): void {
  agents.settingsSection = 'terminal'
  agents.settingsOpen = true
}

defineExpose({ clear })
</script>

<template>
  <section class="terminal-panel" aria-label="Terminal">
    <form v-if="status !== 'connected' && status !== 'connecting'" class="terminal-connect" @submit.prevent="connect">
      <div class="terminal-connect-card">
        <div class="terminal-connect-title">选择连接预设</div>
        <p v-if="!presets.length" class="terminal-help">还没有可用预设，请先到设置页面保存一个连接。</p>
        <label class="terminal-field">
          连接预设
          <select v-model="selectedPresetId" required @change="applyPreset(selectedPresetId)">
            <option value="" disabled>请选择预设</option>
            <option v-for="preset in presets" :key="preset.id" :value="preset.id">
              {{ preset.label }} · {{ preset.kind === 'local' ? '本机' : `${preset.username}@${preset.host}` }}
            </option>
          </select>
        </label>
        <div class="terminal-connect-actions">
          <button type="submit" class="terminal-primary" :disabled="!selectedPresetId || !canConnect">
            连接 Terminal
          </button>
          <button type="button" class="terminal-secondary" @click="openSettings">设置凭据</button>
        </div>
        <p class="terminal-help">连接信息由服务端加密保存；本页只读取预设摘要，不显示密码。</p>
      </div>
    </form>

    <p v-if="error" class="terminal-error" role="alert">{{ error }}</p>
    <div ref="host" class="terminal-screen" />
    <footer class="terminal-footer">Enter 执行 · Tab 补全 · 方向键历史 · Ctrl+C 中断</footer>
  </section>
</template>

<style scoped>
.terminal-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; color: var(--nx-text); background: color-mix(in srgb, var(--nx-bg) 96%, var(--accent)); }
.terminal-secondary, .terminal-primary { border: 1px solid var(--el-border-color); border-radius: 0; padding: 6px 9px; color: inherit; background: var(--el-fill-color-blank); font: inherit; cursor: pointer; }
.terminal-secondary:hover, .terminal-primary:hover:not(:disabled) { border-color: color-mix(in srgb, var(--accent) 60%, var(--el-border-color)); background: color-mix(in srgb, var(--accent) 10%, var(--el-fill-color-blank)); }
.terminal-connect { flex: none; padding: 14px; border-bottom: 1px solid var(--el-border-color); }
.terminal-connect-card { display: flex; flex-wrap: wrap; align-items: end; gap: 10px 12px; max-width: 760px; padding: 12px; border: 1px solid var(--el-border-color); background: color-mix(in srgb, var(--el-fill-color) 35%, transparent); }
.terminal-connect-title { flex: 1 1 100%; font-weight: 600; }
.terminal-field { display: flex; flex: 1 1 280px; flex-direction: column; gap: 5px; color: var(--el-text-color-secondary); font-size: 12px; }
select { min-width: 0; padding: 8px; border: 1px solid var(--el-border-color); border-radius: 0; color: inherit; background: var(--el-fill-color-blank); font: inherit; }
.terminal-connect-actions { display: flex; gap: 8px; }
.terminal-primary { border-color: color-mix(in srgb, var(--accent) 55%, var(--el-border-color)); background: color-mix(in srgb, var(--accent) 14%, var(--el-fill-color-blank)); }
button:disabled { cursor: not-allowed; opacity: .5; }
.terminal-help, .terminal-footer { margin: 0; color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.5; }
.terminal-help { flex: 1 1 100%; }
.terminal-error { flex: none; margin: 10px 14px; color: var(--el-color-danger); font-size: 12px; }
.terminal-screen { flex: 1; min-height: 140px; overflow: hidden; padding: 10px; background: color-mix(in srgb, var(--el-bg-color) 92%, #000); color: var(--el-text-color-primary); }
.terminal-footer { flex: none; padding: 8px 14px; border-top: 1px solid var(--el-border-color); }
@media (max-width: 600px) { .terminal-connect-actions { flex-basis: 100%; } }
</style>
