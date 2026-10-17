<script setup lang="ts">
import { computed } from 'vue'
import { FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, type HttpFileServiceAdapterId } from '@chery/protocol'
interface Field { type?: string; enum?: Array<string | number | boolean>; const?: unknown; minimum?: number; maximum?: number; multipleOf?: number; properties?: Record<string, Field>; items?: Field }
const props = defineProps<{ adapter?: string; modelValue: Record<string, unknown>; fields?: Record<string, Field> }>()
const emit = defineEmits<{ 'update:modelValue': [Record<string, unknown>] }>()
const fields = computed(() => {
  if (props.fields) return props.fields
  const schema = FILE_SERVICE_ADAPTER_PARAM_SCHEMAS[props.adapter as HttpFileServiceAdapterId]
  const json = schema?.toJSONSchema() as { properties?: Record<string, Field> } | undefined
  return Object.fromEntries(Object.entries(json?.properties ?? {}).filter(([name]) => name !== 'prompt'))
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
  const previous = Array.isArray(props.modelValue[name]) ? props.modelValue[name] as string[] : []
  const next = checked ? [...new Set([...previous, value])] : previous.filter(item => item !== value)
  update(name, next.length ? next : undefined)
}
</script>
<template>
  <div class="parameter-fields">
    <template v-for="(field, name) in fields" :key="name">
      <fieldset v-if="field.type === 'object'"><legend>{{ labels[name] ?? name }}</legend><FileServiceParameterFields :fields="field.properties" :model-value="(modelValue[name] as Record<string, unknown>) ?? {}" @update:model-value="update(name, $event)" /></fieldset>
      <fieldset v-else-if="field.type === 'array'"><legend>{{ labels[name] ?? name }}</legend><label v-for="value in field.items?.enum ?? []" :key="String(value)"><input type="checkbox" :checked="(modelValue[name] as unknown[] | undefined)?.includes(value)" @change="toggleArray(name, String(value), ($event.target as HTMLInputElement).checked)" />{{ value }}</label></fieldset>
      <label v-else>{{ labels[name] ?? name }}
        <select v-if="field.enum || field.type === 'boolean' || field.const !== undefined" :value="modelValue[name] ?? ''" @change="change(name, field, $event)"><option value="">使用服务默认值</option><option v-for="value in field.enum ?? (field.type === 'boolean' ? [true, false] : [field.const])" :key="String(value)" :value="String(value)">{{ value === true ? '开启' : value === false ? '关闭' : value }}</option></select>
        <input v-else :type="['integer', 'number'].includes(field.type ?? '') ? 'number' : 'text'" :min="field.minimum" :max="field.maximum" :step="field.multipleOf ?? (field.type === 'integer' ? 1 : 'any')" :value="modelValue[name] ?? ''" placeholder="使用服务默认值" @change="change(name, field, $event)" />
      </label>
    </template>
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
