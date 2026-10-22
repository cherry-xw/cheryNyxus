<script setup lang="ts">
import {
  isImageOutputOperation,
  mergeImageOutputCapability,
  type ImageOutputCapabilities,
  type ImageOutputCapability,
} from '@chery/protocol'
import { FILE_OPERATION_LABELS } from '../../model/fileServices'
import { imageOutputDraftErrors, updateImageOutputDraft } from '../../model/imageOutputDraft'
const props = defineProps<{ modelValue?: ImageOutputCapabilities; inherited?: ImageOutputCapabilities; operations: string[] }>()
const emit = defineEmits<{ 'update:modelValue': [ImageOutputCapabilities | undefined] }>()
function update(operation: string, patch?: Partial<ImageOutputCapability>) {
  if (!isImageOutputOperation(operation)) return
  emit('update:modelValue', updateImageOutputDraft(props.modelValue, operation, patch, props.inherited?.[operation]))
}
function errors(operation: string): string {
  return imageOutputDraftErrors(props.modelValue, operation)
}
function inheritedText(operation: string): string {
  if (!isImageOutputOperation(operation)) return ''
  const resolved = mergeImageOutputCapability(operation, undefined, props.inherited)
  const cap = resolved.value
  return `继承${resolved.source === 'catalog' ? '目录' : '默认处理'}：多图 ${cap.nativeMultiImage}；张数控制 ${cap.countControl}；单次上限 ${cap.nativeMultiImage === 'unsupported' ? 1 : cap.maxImagesPerRequest ?? '未确认'}；合计 ${cap.maxInputAndOutputImages ?? '不增加额外限制'}`
}
</script>
<template>
  <details v-if="operations.some(isImageOutputOperation)">
    <summary>图片模型的原生张数限制</summary>
    <p>未手动设置时继承对应型号与接口的目录限制；手动设置尚未验证，不能增加接口未实现的能力。</p>
    <fieldset v-for="operation in operations.filter(isImageOutputOperation)" :key="operation">
      <legend>{{ FILE_OPERATION_LABELS[operation] }}</legend>
      <small>{{ inheritedText(operation) }}</small>
      <button type="button" @click="update(operation)">恢复目录限制</button>
      <label
        >原生多图<select
          :value="modelValue?.[operation]?.nativeMultiImage ?? ''"
          @change="
            update(operation, {
              nativeMultiImage: ($event.target as HTMLSelectElement)
                .value as ImageOutputCapability['nativeMultiImage'],
            })
          "
        >
          <option value="" disabled>继承目录</option>
          <option value="supported">支持</option>
          <option value="unsupported">只支持单图</option>
          <option value="unknown">未确认</option>
        </select></label
      >
      <label
        >张数控制<select
          :value="modelValue?.[operation]?.countControl ?? ''"
          @change="
            update(operation, {
              countControl: ($event.target as HTMLSelectElement)
                .value as ImageOutputCapability['countControl'],
            })
          "
        >
          <option value="" disabled>继承目录</option>
          <option value="requested">按张数请求</option>
          <option value="maximum">最多几张</option>
          <option value="uncontrolled">模型决定返回数量</option>
          <option value="unknown">未确认</option>
        </select></label
      >
      <label
        >单次输出上限<input
          type="number"
          min="1"
          step="1"
          :value="modelValue?.[operation]?.maxImagesPerRequest ?? ''"
          @input="
            update(operation, {
              maxImagesPerRequest:
                ($event.target as HTMLInputElement).value === ''
                  ? undefined
                  : Number(($event.target as HTMLInputElement).value),
            })
          "
      /></label>
      <label
        >参考图与输出合计上限（没有则留空）<input
          type="number"
          min="1"
          step="1"
          :value="modelValue?.[operation]?.maxInputAndOutputImages ?? ''"
          @input="
            update(operation, {
              maxInputAndOutputImages:
                ($event.target as HTMLInputElement).value === ''
                  ? undefined
                  : Number(($event.target as HTMLInputElement).value),
            })
          "
      /></label>
      <p v-if="errors(operation)" role="alert">{{ errors(operation) }}</p>
    </fieldset>
  </details>
</template>
<style scoped>
details,
fieldset {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
fieldset {
  border: 1px solid var(--border);
  margin: 10px 0;
  padding: 12px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
input,
select,
button {
  font: inherit;
  color: var(--ink);
  background: var(--surface);
  border: 1px solid var(--border-strong);
  padding: 7px;
  min-width: 0;
}
p {
  margin: 0;
  line-height: 1.5;
}
:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
