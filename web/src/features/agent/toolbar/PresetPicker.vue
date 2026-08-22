<script setup lang="ts">
/**
 * PresetPicker：预设选择器组件。
 * 从 AgentFab 拆出，含内部 button + popover + backdrop + transition。
 * 列表 = 配置预设 − excluded（CHERY_NYXUS + 已打开成 pet 的）；全部打开 → 隐藏触发按钮。
 * 无任何预设配置 → 显式空态；加载失败 → 显式错误与重试，二者都不得降级成无感官组会话。
 */
import { computed, onMounted, ref, watch } from 'vue'
import { fetchServerConfig, type PresetOption } from '@/services/agentApi'

const props = withDefaults(
  defineProps<{
    disabled: boolean
    excluded?: string[]
  }>(),
  { excluded: () => [] },
)

const emit = defineEmits<{
  (e: 'pick', presetName: string): void
  (e: 'has-creatable', has: boolean): void
}>()

const pickerOpen = ref(false)
const configPresets = ref<PresetOption[]>([])
const configLoaded = ref(false)
const configLoading = ref(false)
const loadError = ref('')

/** 可创建的预设 = 配置预设 − 已排除（随 excluded 响应式，打开 pet 后自动减少）。 */
const creatable = computed(() => {
  const excluded = new Set(props.excluded)
  return configPresets.value.filter((preset) => !excluded.has(preset.name))
})
/** 配置加载完成前不显示按钮（避免「先出现后消失」闪现）；无任何配置 → 保留按钮走 fallback。 */
const showTrigger = computed(
  () =>
    configLoaded.value &&
    (!!loadError.value || configPresets.value.length === 0 || creatable.value.length > 0),
)

async function loadPresets(force = false): Promise<void> {
  if ((!force && configLoaded.value) || configLoading.value) return
  configLoading.value = true
  loadError.value = ''
  try {
    configPresets.value = (await fetchServerConfig()).presets ?? []
  } catch (cause) {
    configPresets.value = []
    loadError.value = cause instanceof Error ? cause.message : '预设列表加载失败'
  } finally {
    configLoaded.value = true
    configLoading.value = false
  }
}

// 打开工具环即预载配置；加载完成与可创建状态变化时上报，供父级按实际按钮数排布。
onMounted(loadPresets)
watch(showTrigger, (v) => emit('has-creatable', v), { immediate: true })

async function handleClick(): Promise<void> {
  if (props.disabled) return
  await loadPresets()
  pickerOpen.value = !pickerOpen.value
}

async function retryLoad(): Promise<void> {
  await loadPresets(true)
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
        <div v-if="loadError" class="picker-state is-error" role="alert">
          <span>预设列表加载失败：{{ loadError }}</span>
          <button type="button" class="picker-retry" :disabled="configLoading" @click="retryLoad">
            {{ configLoading ? '重试中…' : '重试' }}
          </button>
        </div>
        <div v-else-if="configPresets.length === 0" class="picker-state">
          暂无预设，请先在设置中添加预设
        </div>
        <button
          v-for="p in loadError ? [] : creatable"
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
    <span
      v-if="showTrigger"
      class="picker-trigger"
      @click="handleClick"
    >
      <slot />
    </span>
  </div>
</template>

<style scoped lang="less">
@ink: var(--ink);

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
  background: var(--panel);
  box-shadow:
    0 14px 30px color-mix(in srgb, var(--ink) 22%, transparent),
    0 3px 8px color-mix(in srgb, var(--ink) 12%, transparent);
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.picker-title {
  font-size: 11px;
  font-weight: 600;
  color: color-mix(in srgb, var(--ink) 56%, transparent);
  padding: 2px 6px 4px;
  letter-spacing: 0.02em;
}

.picker-state {
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 8px;
  font-size: 12px;
  line-height: 1.5;
  color: color-mix(in srgb, var(--ink) 62%, transparent);

  &.is-error {
    color: var(--el-color-danger, #d14343);
  }
}

.picker-retry {
  align-self: flex-start;
  padding: 3px 9px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 6px;
  color: color-mix(in srgb, var(--ink) 82%, transparent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  cursor: pointer;

  &:disabled {
    cursor: wait;
    opacity: 0.6;
  }
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
    background: color-mix(in srgb, var(--accent) 18%, transparent);
  }

  .pi-name {
    font-size: 13px;
    font-weight: 600;
    color: color-mix(in srgb, var(--ink) 86%, transparent);
  }

  .pi-meta {
    font-size: 10px;
    color: color-mix(in srgb, var(--ink) 50%, transparent);
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
