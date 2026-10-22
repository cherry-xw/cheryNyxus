<script setup lang="ts">
import type { BrainCapabilities } from '@chery/plugin-api'
import type { mergeBrainCapabilities } from '../../protocol/src/brainCapabilities'
const props = defineProps<{ brain: { capabilities?: BrainCapabilities }; inherited?: ReturnType<typeof mergeBrainCapabilities>; catalogStatus?: 'loading' | 'ready' | 'error' }>()
const formats = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
function change(key: string, value: unknown) {
  const caps = { ...props.brain.capabilities }
  const target = { ...caps.imageInput } as Record<string, unknown>
  if (value === undefined) delete target[key]
  else target[key] = value
  if (Object.keys(target).length) caps.imageInput = target
  else delete caps.imageInput
  if (Object.keys(caps).length) props.brain.capabilities = caps
  else delete props.brain.capabilities
}
function nativeState(event: Event) {
  const caps = { ...props.brain.capabilities }
  const input = { ...caps.input }
  const value = (event.target as HTMLSelectElement).value
  if (!value) delete input.image
  else input.image = value as 'supported' | 'unsupported' | 'unknown'
  if (Object.keys(input).length) caps.input = input
  else delete caps.input
  if (Object.keys(caps).length) props.brain.capabilities = caps
  else delete props.brain.capabilities
}
function toggle(format: typeof formats[number], event: Event) {
  const selected = props.brain.capabilities?.imageInput?.formats ?? []
  change('formats', (event.target as HTMLInputElement).checked ? [...selected, format] : selected.filter(f => f !== format))
}
</script>
<template>
  <details>
    <summary>模型原生图片格式与限制</summary>
    <p>省略继承模型目录；未知模型须按实际服务声明能力与格式，不能从协议推断。</p>
    <label>原生图片能力<select :value="brain.capabilities?.input?.image === true ? 'supported' : brain.capabilities?.input?.image === false ? 'unsupported' : brain.capabilities?.input?.image ?? ''" @change="nativeState"><option value="">{{ catalogStatus !== 'ready' ? '目录尚未取得' : `继承：${inherited?.input.image.state ?? 'unknown'} · ${inherited?.input.image.source ?? 'default'}` }}</option><option value="supported">支持</option><option value="unsupported">不支持</option><option value="unknown">未知</option></select></label>
    <label><input type="checkbox" :checked="brain.capabilities?.imageInput?.formats !== undefined" @change="change('formats', ($event.target as HTMLInputElement).checked ? [...(inherited?.imageInput.formats ?? [])] : undefined)" />覆盖目录格式</label>
    <template v-if="brain.capabilities?.imageInput?.formats !== undefined">
      <label v-for="format in formats" :key="format"><input type="checkbox" :checked="brain.capabilities.imageInput.formats.includes(format)" @change="toggle(format, $event)" />{{ format }}</label>
    </template>
    <p v-else>{{ catalogStatus !== 'ready' ? '目录尚未取得' : inherited?.imageInput.formats ? `继承格式：${inherited.imageInput.formats.join('、') || '不接收图片'}` : '目录未声明格式，不能假定支持' }}</p>
    <label>动画语义<select :value="brain.capabilities?.imageInput?.animation ?? ''" @change="change('animation', ($event.target as HTMLSelectElement).value || undefined)"><option value="">{{ catalogStatus !== 'ready' ? '目录尚未取得' : `继承：${inherited?.imageInput.animation ?? 'unknown'}` }}</option><option value="unknown">未知</option><option value="unsupported">不支持</option><option value="first-frame">服务只读取首帧（不自动携带动图）</option><option value="supported">完整动画支持（需服务明确保证）</option></select></label>
    <label v-for="[key, label] in [['maxBytes', '服务单图原始字节上限'], ['maxBase64Bytes', '服务单图 Base64 字节上限']]" :key="key">{{ label }}（清空恢复继承）<input type="text" inputmode="numeric" :value="brain.capabilities?.imageInput?.[key as 'maxBytes' | 'maxBase64Bytes'] ?? ''" :placeholder="catalogStatus !== 'ready' ? '目录尚未取得' : inherited?.imageInput[key as 'maxBytes' | 'maxBase64Bytes'] !== undefined ? String(inherited.imageInput[key as 'maxBytes' | 'maxBase64Bytes']) + ' · 目录' : '不增加额外限制'" @input="change(key!, ($event.target as HTMLInputElement).value.trim() ? Number(($event.target as HTMLInputElement).value) : undefined)" /></label>
  </details>
</template>
