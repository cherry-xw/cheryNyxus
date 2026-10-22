<script setup lang="ts">
/** 理解输入与原生输出入口；文件输出仅选择尚无配置的空白面板。 */
import type {
  CapabilityValueDto,
  MediaCapabilitiesDto,
  OutputCapabilitiesDto,
} from '@/application/backend/public'
import type { CapabilityField } from '@chery/protocol'

import {
  BRAIN_MEDIA_OPTIONS,
  type BrainMediaGroup,
  type BrainMediaKind,
} from '../brain/brainMediaOptions'

function isSupported(val: CapabilityValueDto | undefined): boolean {
  return val === true || val === 'supported'
}

const props = defineProps<{
  input: MediaCapabilitiesDto
  output: OutputCapabilitiesDto
  fileOutputSelected?: boolean
  disabled?: boolean
  sources?: { input: Record<string, CapabilityField>; output: Record<string, CapabilityField> }
  catalogStatus?: 'loading' | 'ready' | 'error'
}>()

const emit = defineEmits<{
  (e: 'toggle', group: BrainMediaGroup, kind: BrainMediaKind): void
}>()

function selected(group: BrainMediaGroup, kind: BrainMediaKind): boolean {
  if (group === 'input') return isSupported(props.input[kind === 'file' ? 'pdf' : kind])
  return kind === 'file' ? !!props.fileOutputSelected : isSupported(props.output[kind])
}
function baseLabel(group: BrainMediaGroup, kind: BrainMediaKind, name: string): string {
  if (kind === 'file')
    return group === 'input' ? '文件输入（PDF）' : '文件输出（未实现，仅空白页，不保存）'
  return `${name}${group === 'input' ? '输入' : '输出'}`
}
function tooltipLabel(group: BrainMediaGroup, kind: BrainMediaKind, name: string): string {
  if (kind === 'file') return baseLabel(group, kind, name)
  const field = props.sources?.[group]?.[kind]
  const status = field?.state === 'supported' ? '支持' : field?.state === 'unsupported' ? '不支持' : '未确认'
  const source = field?.source === 'user' ? '手动设置' : props.catalogStatus === 'loading' ? '目录读取中' : props.catalogStatus === 'error' ? '目录读取失败' : field?.source === 'catalog' ? '目录' : '默认处理'
  return `${baseLabel(group, kind, name)} · ${status} · ${source}`
}
</script>

<template>
  <div class="cap-row" role="group" aria-label="媒体能力">
    <div v-for="group in ['input', 'output'] as const" :key="group" class="cap-group">
      <div class="cap-group-head">
        <strong>{{ group === 'input' ? '理解输入' : '原生输出' }}</strong>
      </div>
      <el-tooltip
        v-for="cap in BRAIN_MEDIA_OPTIONS"
        :key="cap.key"
        :content="tooltipLabel(group, cap.key, cap.label)"
        :show-after="0"
        placement="top"
      >
        <button
          type="button"
          class="cap-item"
          :class="{ active: selected(group, cap.key) }"
          :disabled="disabled"
          :aria-label="baseLabel(group, cap.key, cap.label)"
          :aria-pressed="selected(group, cap.key)"
          @click="emit('toggle', group, cap.key)"
        >
          <span class="cap-face cap-front" aria-hidden="true">
            <component :is="cap.icon" class="cap-icon" />
          </span>
          <span class="cap-face cap-back" aria-hidden="true">{{
            group === 'input' ? cap.inputEmoji : cap.outputEmoji
          }}</span>
        </button>
      </el-tooltip>
    </div>
  </div>
</template>

<style scoped lang="less">
.cap-row {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid color-mix(in srgb, var(--ink) 9%, transparent);
}

.cap-group {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cap-group-head {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1px;
  padding-right: 2px;

  strong {
    color: color-mix(in srgb, var(--ink) 82%, transparent);
    font-size: 13px;
    line-height: 1.1;
  }
  small {
    color: color-mix(in srgb, var(--ink) 62%, transparent);
    font-size: 12px;
    line-height: 1.1;
  }
}

.cap-item {
  position: relative;
  width: 24px;
  height: 24px;
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  border-radius: 6px;
  background: var(--surface-soft);
  cursor: pointer;
  perspective: 220px;
  transform-style: preserve-3d;
  transition:
    border-color 0.18s ease,
    background 0.18s ease,
    box-shadow 0.18s ease;

  &:hover:not(:disabled) {
    border-color: color-mix(in srgb, var(--warning) 30%, transparent);
    background: color-mix(in srgb, var(--accent) 8%, transparent);
  }

  &:active:not(:disabled) {
    transform: scale(0.96);
  }

  &:focus-visible {
    outline: 2px solid color-mix(in srgb, var(--accent) 65%, transparent);
    outline-offset: 1px;
  }

  &:disabled {
    opacity: 0.38;
    cursor: not-allowed;
  }

  &.active {
    border-color: color-mix(in srgb, var(--warning) 34%, transparent);
    background: linear-gradient(
      145deg,
      color-mix(in srgb, var(--accent) 12%, var(--surface)),
      color-mix(in srgb, var(--accent) 16%, transparent)
    );
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.45);
  }
}

.cap-face {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  backface-visibility: hidden;
  -webkit-backface-visibility: hidden;
  border-radius: 5px;
  transition: transform 0.42s cubic-bezier(0.22, 1.35, 0.36, 1);
  transform-style: preserve-3d;
}

.cap-front {
  transform: rotateY(0deg);
  color: color-mix(in srgb, var(--ink) 72%, transparent);
}

.cap-back {
  transform: rotateY(-180deg);
  font-size: 15px;
  line-height: 1;
}

.cap-item.active .cap-front {
  transform: rotateY(180deg);
}
.cap-item.active .cap-back {
  transform: rotateY(0deg);
}

.cap-icon {
  width: 13px;
  height: 13px;
}

@media (max-width: 560px) {
  .cap-row {
    flex-wrap: wrap;
    gap: 8px;
  }
  .cap-item {
    width: 22px;
    height: 22px;
  }
}
</style>
