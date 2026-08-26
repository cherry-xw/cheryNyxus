<script setup lang="ts">
/**
 * OpenConfigDirButton：公共「打开配置文件夹」按钮（settings / 错误弹窗复用）。
 *
 * 通过后端 RPC `utils.openConfigDir` 打开后端主机的 .chery 配置目录。
 * 连接状态与防抖内部管理（useConnectionStore + 内部 opening ref）；
 * 失败时 emit `error`，由父组件决定如何呈现（SettingsDialog 走统一错误弹窗）。
 *
 * 两变体：
 * - `icon`（默认）：标题栏 / header 用，FolderOpened 图标 + tooltip「打开配置文件夹」
 * - `ghost`：错误弹窗 footer 用，文本按钮（默认「打开配置目录」）
 */
import { ref } from 'vue'
import { ElTooltip } from 'element-plus'
import { FolderOpened } from '@element-plus/icons-vue'
import { useConnectionStore } from '@/application/public'
import { agentApi } from '@/application/backend/public'

const props = withDefaults(
  defineProps<{
    variant?: 'icon' | 'ghost'
    label?: string
  }>(),
  {
    variant: 'icon',
    label: '打开配置目录',
  },
)

const emit = defineEmits<{ (e: 'error', message: string): void }>()

const connection = useConnectionStore()
const opening = ref(false)

const disabled = () => connection.status !== 'connected' || opening.value

async function onClick(): Promise<void> {
  if (connection.status !== 'connected' || opening.value) return
  opening.value = true
  try {
    await agentApi.openConfigDir()
  } catch (e) {
    const message = (e as Error).message
    console.error('[OpenConfigDirButton] openConfigDir failed:', e)
    emit('error', message)
  } finally {
    opening.value = false
  }
}
</script>

<template>
  <el-tooltip
    v-if="variant === 'icon'"
    content="打开配置文件夹"
    placement="top"
    :show-after="120"
  >
    <span class="tooltip-trigger">
      <button
        type="button"
        class="open-btn"
        :disabled="disabled()"
        :aria-busy="opening"
        aria-label="打开配置文件夹"
        @click="onClick"
      >
        <FolderOpened class="open-ico" />
      </button>
    </span>
  </el-tooltip>
  <button
    v-else
    type="button"
    class="ghost-btn"
    :disabled="disabled()"
    :aria-busy="opening"
    @click="onClick"
  >
    {{ label }}
  </button>
</template>

<style scoped lang="less">
.tooltip-trigger {
  display: inline-flex;
}
.open-btn {
  width: 24px;
  height: 24px;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 82%, transparent);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  &:hover:not(:disabled) {
    background: var(--surface);
    color: color-mix(in srgb, var(--ink) 92%, transparent);
  }
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}
.open-ico {
  width: 14px;
  height: 14px;
}

.ghost-btn {
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-soft);
  color: color-mix(in srgb, var(--ink) 88%, transparent);
  font-size: 12px;
  cursor: pointer;
  &:hover:not(:disabled) {
    background: var(--surface);
    color: color-mix(in srgb, var(--ink) 94%, transparent);
  }
  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
}
</style>
