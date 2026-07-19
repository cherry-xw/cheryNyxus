<script setup lang="ts">
/**
 * PresetPicker：预设选择器组件。
 * 从 AgentFab 拆出，含内部 button + popover + backdrop + transition。
 * 点击加载预设列表；空 → emit fallback；非空 → toggle picker。
 */
import { ref } from 'vue'
import { fetchServerConfig, type PresetOption } from '@/services/agentApi'

defineProps<{
  disabled: boolean
}>()

const emit = defineEmits<{
  (e: 'pick', presetName: string): void
  (e: 'fallback'): void
}>()

const pickerOpen = ref(false)
const presets = ref<PresetOption[]>([])

async function loadPresets(): Promise<void> {
  if (presets.value.length > 0) return
  try {
    const cfg = await fetchServerConfig()
    presets.value = cfg.presets ?? []
  } catch {
    presets.value = []
  }
}

async function handleClick(): Promise<void> {
  await loadPresets()
  // 无预设 → emit fallback；有预设 → toggle picker
  if (presets.value.length === 0) {
    emit('fallback')
  } else {
    pickerOpen.value = !pickerOpen.value
  }
}

function pickPreset(name: string): void {
  pickerOpen.value = false
  emit('pick', name)
}
</script>

<template>
  <div class="picker-wrap">
    <transition name="picker-fade">
      <div v-if="pickerOpen" class="picker-popover">
        <div class="picker-title">选择预设</div>
        <button
          v-for="p in presets"
          :key="p.name"
          type="button"
          class="picker-item"
          @click="pickPreset(p.name)"
        >
          <span class="pi-name">{{ p.name }}</span>
          <span class="pi-meta">{{ p.leader }} · {{ p.roles.length }} 角色</span>
        </button>
      </div>
    </transition>
    <div v-if="pickerOpen" class="picker-backdrop" @click="pickerOpen = false" />
    <button type="button" class="picker-trigger" :disabled="disabled" @click="handleClick">
      <slot />
    </button>
  </div>
</template>

<style scoped lang="less">
@ink: #14161a;

.picker-wrap {
  position: relative;
  display: contents;
}

.picker-backdrop {
  position: fixed;
  inset: 0;
  z-index: 199;
}

.picker-popover {
  position: absolute;
  right: 0;
  bottom: 100%;
  margin-bottom: 8px;
  z-index: 201;
  width: 220px;
  padding: 8px;
  border-radius: 12px;
  background: #fbf9f4;
  border: 1px solid rgba(36, 38, 45, 0.14);
  box-shadow:
    0 14px 30px rgba(0, 0, 0, 0.22),
    0 3px 8px rgba(0, 0, 0, 0.12);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.picker-title {
  font-size: 11px;
  font-weight: 800;
  color: fade(@ink, 56%);
  padding: 2px 6px 4px;
  letter-spacing: 0.02em;
}

.picker-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 6px 8px;
  border: none;
  border-radius: 8px;
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition: background 100ms ease;

  &:hover {
    background: fade(#f6b73c, 18%);
  }

  .pi-name {
    font-size: 13px;
    font-weight: 700;
    color: fade(@ink, 86%);
  }

  .pi-meta {
    font-size: 10px;
    color: fade(@ink, 50%);
  }
}

.picker-trigger {
  display: contents;
}

.picker-fade-enter-active,
.picker-fade-leave-active {
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.picker-fade-enter-from,
.picker-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>
