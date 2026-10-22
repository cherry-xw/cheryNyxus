<script setup lang="ts">
import { computed, useId } from 'vue'
import { imageParameterFieldsForContext, imageParameterDisplay, imageParameterErrors, mergeImageParameters, type ImageParameterField as Field } from '@chery/protocol'
const props = withDefaults(defineProps<{ adapter?: string; model?: string; operation?: string; operations?: string[]; modelValue: Record<string, unknown>; inherited?: Record<string, unknown>; rootParams?: Record<string, unknown>; rootInherited?: Record<string, unknown>; path?: string; fields?: Record<string, Field>; primary?: boolean }>(), { primary: undefined, path: '' })
const emit = defineEmits<{ 'update:modelValue': [Record<string, unknown>] }>()
const id = useId()
const effective = computed(() => mergeImageParameters(props.rootInherited ?? props.inherited, props.rootParams ?? props.modelValue))
const context = computed(() => ({ adapter: props.adapter ?? '', model: props.model, operation: props.operation, operations: props.operations, params: effective.value }))
const errors = computed(() => props.path ? [] : imageParameterErrors(props.adapter ?? '', { ...effective.value, prompt: '参数检查' }, props.model ?? ''))
function info(name: string) { return imageParameterDisplay(context.value, props.path + name, props.rootInherited ?? props.inherited) }
function shown(name: string) { return props.modelValue[name] ?? info(name).value }
function nested(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
const fields = computed(() => {
  if (props.fields) return props.fields
  const fields = imageParameterFieldsForContext(context.value)
  const primary = ['size', 'width', 'height', 'aspect_ratio', 'aspectRatio', 'imageConfig']
  return props.primary === undefined ? fields : Object.fromEntries(Object.entries(fields).filter(([key]) => primary.includes(key) === props.primary))
})
const labels: Record<string, string> = { n:'生成数量', sampleCount:'生成数量', aspect_ratio:'画面比例', aspectRatio:'画面比例', width:'宽度（像素）', height:'高度（像素）', size:'图片尺寸', quality:'输出质量', background:'背景', output_format:'文件格式', output_compression:'有损压缩程度', moderation:'内容检查强度', input_fidelity:'参考细节保留', image_model:'图片工具型号（与对话型号分别填写）', maskAssetId:'蒙版文件 ID', response_format:'服务返回形式', prompt_optimizer:'优化提示', aigc_watermark:'添加水印', seed:'随机种子', style:'画风', style_type:'画风类型', style_weight:'画风强度', imageConfig:'图片设置', imageSize:'图片大小', responseModalities:'返回内容', outputOptions:'输出设置', mimeType:'文件格式', personGeneration:'人物生成限制', watermark:'添加水印', sequential_image_generation:'连续组图', sequential_image_generation_options:'组图设置', max_images:'最大图片数', stream:'流式返回', partial_images:'预览次数', action:'生成或编辑' }
function update(name: string, value: unknown) {
  const next = { ...props.modelValue }
  if (value === undefined || value === '' || value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) delete next[name]
  else next[name] = value
  emit('update:modelValue', next)
}
function change(name: string, field: Field, event: Event) {
  const raw = (event.target as HTMLInputElement).value
  update(name, raw === '' ? undefined : field.type === 'boolean' ? raw === 'true' : ['integer', 'number'].includes(field.type ?? '') ? Number(raw) : raw)
}
function toggleArray(name: string, value: string, checked: boolean) {
  const previous = Array.isArray(shown(name)) ? shown(name) as string[] : []
  const next = checked ? [...new Set([...previous, value])] : previous.filter(item => item !== value)
  update(name, next)
}
</script>
<template>
  <div class="parameter-fields">
    <template v-for="(field, name) in fields" :key="name">
       <fieldset v-if="field.type === 'object'"><legend>{{ labels[name] ?? name }}</legend><FileServiceParameterFields :adapter="adapter" :model="model" :operation="operation" :operations="operations" :fields="field.properties" :path="path + name + '.'" :root-params="rootParams ?? modelValue" :root-inherited="rootInherited ?? inherited" :inherited="nested(inherited?.[name])" :model-value="nested(modelValue[name])" @update:model-value="update(name, $event)" /></fieldset>
       <fieldset v-else-if="field.type === 'array'"><legend>{{ labels[name] ?? name }}</legend><small>{{ modelValue[name] === undefined ? info(name).text : '手动设置' }}</small><label v-for="value in field.items?.enum ?? []" :key="String(value)"><input type="checkbox" :aria-describedby="errors.length ? id : undefined" :checked="(shown(name) as unknown[] | undefined)?.includes(value)" @change="toggleArray(name, String(value), ($event.target as HTMLInputElement).checked)" />{{ value }}</label><button v-if="modelValue[name] !== undefined" type="button" @click="update(name, undefined)">恢复上层值</button></fieldset>
       <label v-else>{{ labels[name] ?? name }}
         <span v-if="field.const !== undefined">{{ info(name).text }}</span>
         <select v-else-if="field.enum || field.type === 'boolean'" :value="modelValue[name] ?? ''" :aria-invalid="!!errors.length" :aria-describedby="errors.length ? id : undefined" @change="change(name, field, $event)"><option value="">{{ info(name).text }}</option><option v-for="value in field.enum ?? [true, false]" :key="String(value)" :value="String(value)">{{ value === true ? '开启' : value === false ? '关闭' : value }}</option></select>
         <input v-else :type="['integer', 'number'].includes(field.type ?? '') && info(name).source !== 'unknown' ? 'number' : 'text'" :inputmode="['integer', 'number'].includes(field.type ?? '') ? 'decimal' : undefined" :min="field.minimum" :max="field.maximum" :step="field.multipleOf ?? (field.type === 'integer' ? 1 : 'any')" :value="shown(name) ?? ''" :placeholder="info(name).text" :aria-invalid="!!errors.length" :aria-describedby="errors.length ? id : undefined" @change="change(name, field, $event)" />
         <small v-if="modelValue[name] === undefined && !field.enum && field.type !== 'boolean' && field.const === undefined">{{ info(name).text }}</small>
         <button v-if="modelValue[name] !== undefined && field.const === undefined" type="button" @click="update(name, undefined)">恢复上层值</button>
       </label>
    </template>
    <p v-if="errors.length" :id="id" role="alert">{{ errors.join('\n') }}</p>
  </div>
</template>
<style scoped>
.parameter-fields { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr)); gap:12px; min-width:0; }
label { display:flex; flex-direction:column; gap:6px; min-width:0; font-size:14px; line-height:1.5; }
fieldset { margin:0; padding:10px; border:1px solid var(--border); min-width:0; grid-column:1/-1; }
fieldset label:has(input[type=checkbox]) { display:flex; flex-direction:row; }
input,select { font:inherit; color:var(--ink); background:var(--surface); border:1px solid var(--border-strong); padding:7px; min-width:0; }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>
