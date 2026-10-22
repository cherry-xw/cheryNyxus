<script setup lang="ts">
import { Download, Upload } from '@element-plus/icons-vue'
import { computed, nextTick, ref, watch } from 'vue'
import type { BrainCapabilitiesDto, ModelRecommendationDto } from '@/application/backend/public'
import { mergeBrainCapabilities } from '@chery/protocol'
import MediaCapabilityGrid from '../config/MediaCapabilityGrid.vue'
import BrainImageInputSettings from './BrainImageInputSettings.vue'
import BrainImageOutputSettings from './BrainImageOutputSettings.vue'
import { BRAIN_MEDIA_OPTIONS, type BrainMediaGroup, type BrainMediaKind } from './brainMediaOptions'

const props = defineProps<{ modelValue?: BrainCapabilitiesDto; catalog?: ModelRecommendationDto | null; catalogStatus?: 'loading' | 'ready' | 'error' }>()
const effective = computed(() => mergeBrainCapabilities(props.modelValue, props.catalog?.recommend?.capabilities, props.catalog?.facts?.capabilities))
const inherited = computed(() => mergeBrainCapabilities(undefined, props.catalog?.recommend?.capabilities, props.catalog?.facts?.capabilities))
const displayedInput = computed(() => Object.fromEntries(Object.entries(effective.value.input).map(([key, field]) => [key, field.state])))
const displayedOutput = computed(() => Object.fromEntries(Object.entries(effective.value.output).map(([key, field]) => [key, field.state])))
const emit = defineEmits<{ 'update:modelValue': [value: BrainCapabilitiesDto] }>()
// There is no native file-output field; this selection never enters the saved draft.
const fileOutputSelected = ref(false)
const active = ref('')
function isMediaEnabled(group: BrainMediaGroup, kind: BrainMediaKind): boolean {
  if (kind === 'file')
    return group === 'input'
      ? effective.value.input.pdf.state === 'supported'
      : fileOutputSelected.value
  return effective.value[group][kind].state === 'supported'
}
// 固定保留八个入口位置的顺序；切换只改变位置内的显示，不移动已有 Tab。
const entries = computed(() =>
  (['input', 'output'] as const).flatMap((group) =>
    BRAIN_MEDIA_OPTIONS.map((media) => ({
      ...media,
      group,
      id: `${group}-${media.key}`,
      label: `${media.label}${group === 'input' ? '输入' : '输出'}`,
      enabled: isMediaEnabled(group, media.key),
    })),
  ),
)
const tabs = computed(() => entries.value.filter((entry) => entry.enabled))
watch(
  () => tabs.value.map((tab) => tab.id),
  (ids, previous = []) => {
    if (ids.includes(active.value)) return
    const index = Math.max(0, previous.indexOf(active.value))
    active.value = ids[Math.min(index, ids.length - 1)] ?? ''
  },
  { immediate: true, flush: 'sync' },
)

function toggle(group: BrainMediaGroup, kind: BrainMediaKind): void {
  if (group === 'output' && kind === 'file') {
    fileOutputSelected.value = !fileOutputSelected.value
  } else {
    const caps = props.modelValue
    const key = kind === 'file' ? 'pdf' : kind
    if (group === 'input') {
      const enabled = effective.value.input[key].state !== 'supported'
      emit('update:modelValue', {
        ...caps,
        input: { ...caps?.input, [key]: enabled ? 'supported' : 'unsupported' },
      })
    } else if (kind !== 'file') {
      const enabled = effective.value.output[kind].state !== 'supported'
      emit('update:modelValue', {
        ...caps,
        output: { ...caps?.output, [kind]: enabled ? 'supported' : 'unsupported' },
      })
    } else return
  }
}

const tablist = ref<HTMLElement | null>(null)
function onTabKeydown(event: KeyboardEvent, index: number): void {
  const count = tabs.value.length
  if (!count) return
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % count
  else if (event.key === 'ArrowLeft') next = (index - 1 + count) % count
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = count - 1
  else return
  event.preventDefault()
  const target = tabs.value[next]
  if (!target) return
  active.value = target.id
  void nextTick(() =>
    tablist.value?.querySelector<HTMLButtonElement>(`[data-tab-id="${target.id}"]`)?.focus(),
  )
}

function tabIndex(id: string): number {
  return tabs.value.findIndex((tab) => tab.id === id)
}

function updateOutput(imageOutput: BrainCapabilitiesDto['imageOutput']): void {
  const caps = { ...props.modelValue }
  if (imageOutput === undefined) delete caps.imageOutput
  else caps.imageOutput = imageOutput
  emit('update:modelValue', caps)
}
</script>

<template>
  <div class="brain-media-capabilities">
    <MediaCapabilityGrid
      :input="displayedInput"
      :output="displayedOutput"
      :sources="effective"
      :catalog-status="catalogStatus"
      :file-output-selected="fileOutputSelected"
      @toggle="toggle"
    />
    <div
      v-if="tabs.length"
      ref="tablist"
      class="brain-media-tabs"
      role="tablist"
      aria-label="媒体能力配置"
    >
      <template v-for="entry in entries" :key="entry.id">
        <el-tooltip v-if="entry.enabled" :content="entry.label" :show-after="0">
          <button
            :id="`${entry.id}-tab`"
            type="button"
            role="tab"
            class="media-tab"
            :class="{ active: active === entry.id }"
            :data-tab-id="entry.id"
            :aria-selected="active === entry.id"
            :aria-controls="`${entry.id}-panel`"
            :tabindex="active === entry.id ? 0 : -1"
            @click="active = entry.id"
            @keydown="onTabKeydown($event, tabIndex(entry.id))"
          >
            <span class="media-tab-icons" role="img" :aria-label="entry.label">
              <component :is="entry.icon" aria-hidden="true" />
              <component :is="entry.group === 'input' ? Upload : Download" aria-hidden="true" />
            </span>
          </button>
        </el-tooltip>
      </template>
    </div>
    <div
      v-if="active"
      :id="`${active}-panel`"
      class="brain-media-panel"
      role="tabpanel"
      :aria-labelledby="`${active}-tab`"
    >
      <BrainImageInputSettings
        v-if="active === 'input-image'"
        :model-value="modelValue"
        :inherited="inherited.imageInput"
        :catalog-status="catalogStatus"
        @update:model-value="emit('update:modelValue', $event)"
      />
      <BrainImageOutputSettings
        v-else-if="active === 'output-image'"
        :model-value="modelValue?.imageOutput"
        :inherited="catalog?.recommend?.capabilities?.imageOutput ?? catalog?.facts?.capabilities?.imageOutput"
        :catalog-status="catalogStatus"
        :operations="['image.generate', 'image.reference', 'image.edit']"
        @update:model-value="updateOutput"
      />
    </div>
    <el-button v-if="modelValue?.input || modelValue?.output" size="small" @click="emit('update:modelValue', Object.fromEntries(Object.entries(modelValue ?? {}).filter(([key]) => key !== 'input' && key !== 'output')))">恢复媒体能力目录</el-button>
  </div>
</template>

<style scoped lang="less">
.brain-media-capabilities {
  min-width: 0;
}
.brain-media-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 10px;
  padding: 4px;
  overflow-x: auto;
  border: 1px solid color-mix(in srgb, var(--ink) 9%, transparent);
  border-radius: 8px;
  background: var(--surface-soft);
  scrollbar-width: thin;
}
.media-tab {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  height: 28px;
  padding: 0 10px;
  color: color-mix(in srgb, var(--ink) 66%, transparent);
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  cursor: pointer;
  transition:
    color 0.15s,
    background 0.15s,
    border-color 0.15s,
    box-shadow 0.15s;

  &:hover {
    color: color-mix(in srgb, var(--ink) 82%, transparent);
    background: color-mix(in srgb, var(--tab-color, var(--accent)) 8%, transparent);
  }

  &.active {
    color: color-mix(in srgb, var(--tab-color, var(--accent)) 82%, var(--ink));
    background: color-mix(in srgb, var(--tab-color, var(--accent)) 12%, transparent);
    border-color: color-mix(in srgb, var(--tab-color, var(--accent)) 34%, transparent);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.35);
  }

  &:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 65%, transparent);
    outline-offset: 1px;
  }
}
.media-tab-icons {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;

  svg {
    width: 16px;
    height: 16px;
  }
}
.brain-media-panel {
  min-width: 0;
  margin-top: 8px;
}
</style>
