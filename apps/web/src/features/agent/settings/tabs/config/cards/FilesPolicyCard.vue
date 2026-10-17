<script setup lang="ts">
import { computed, reactive, useId } from 'vue'
import { InfoFilled } from '@element-plus/icons-vue'
import type { ConfigDto } from '@/application/backend/public'
import { SettingsFilesPolicySchema } from '@chery/protocol'

const props = defineProps<{ draft: ConfigDto; no: number }>()
const id = useId()
const invalidInputs = reactive<Record<string, string>>({})
const tipOpen = reactive({ turns: false })
const image = computed(() => props.draft.files?.imageContext ?? {})
const services = computed(() => Object.entries(props.draft.file_services ?? {}).filter(([, service]) => service.enabled !== false && service.operations.includes('image.inspect')))
const serviceError = computed(() => image.value.missingDescription !== 'inspect' ? '' : !image.value.serviceId ? '请选择已启用图片理解操作的文件服务。' : !services.value.some(([key]) => key === image.value.serviceId) ? '所选服务已停用、已删除或未启用图片理解；请重新选择。' : '')
const groups = [
  { key: 'upload', label: '上传与保存', fields: [
    { path: 'maxUploadBytes', label: '单文件上传上限（MiB）', fallback: 100, scale: 1048576, min: 1 },
    { path: 'unreferencedUploadRetentionHours', label: '未提交且无引用的上传保留（小时）', fallback: 24, scale: 1, min: 1 },
    { path: 'unreferencedAssetRetentionHours', label: '最后引用解除后保留（小时）', fallback: 24, scale: 1, min: 1 },
  ] },
  { key: 'image', label: '图片上下文', fields: [
    { path: 'imageContext.recentUserTurns', label: '保留轮数（含首次发送轮）', fallback: 3, scale: 1, min: 1 },
    { path: 'imageContext.maxDescriptionChars', label: '单图说明字符上限', fallback: 600, scale: 1, min: 100 },
    { path: 'imageContext.maxTotalDescriptionChars', label: '单次请求说明字符总上限', fallback: 6000, scale: 1, min: 100 },
  ] },
  { key: 'other', label: '其他文件上下文', fields: [
    { path: 'context.recentUserTurns', label: '其他文件保留用户轮数（0 仅当前轮）', fallback: 3, scale: 1, min: 0 },
    { path: 'context.maxExtractedCharsPerAsset', label: '单文件提取字符上限', fallback: 20000, scale: 1, min: 1 },
    { path: 'context.maxExtractedChars', label: '单次请求提取字符总上限', fallback: 80000, scale: 1, min: 1 },
  ] },
  { key: 'request', label: '请求大小（所有文件）', fields: [
    { path: 'context.maxAssets', label: '单次请求最多文件版本数', fallback: 10, scale: 1, min: 1 },
    { path: 'context.maxBinaryBytes', label: '单次请求附件预算（MiB）', fallback: 16, scale: 1048576, min: 1 },
  ] },
  { key: 'adapt', label: '图片适配', fields: [
    { path: 'imageAdaptation.maxEdge', label: '适配图片最长边（像素）', fallback: 2048, scale: 1, min: 1 },
    { path: 'imageAdaptation.quality', label: 'JPEG/WebP 有损编码质量（1—100）', fallback: 85, scale: 1, min: 1 },
  ] },
]
function read(path: string): unknown {
  const [section, key] = path.split('.')
  const files = props.draft.files as Record<string, unknown> | undefined
  return key ? (files?.[section!] as Record<string, unknown> | undefined)?.[key] : files?.[section!]
}
function write(path: string, value: unknown) {
  props.draft.files ??= {}
  const files = props.draft.files as Record<string, unknown>
  const [section, key] = path.split('.')
  const owner = key ? (files[section!] ??= {}) as Record<string, unknown> : files
  if (value === undefined || value === '') delete owner[key ?? section!]
  else owner[key ?? section!] = value
}
function writeNumber(path: string, value: string, scale: number) {
  delete invalidInputs[path]
  if (!value.trim()) { write(path, undefined); return }
  const number = Number(value)
  if (!Number.isFinite(number)) invalidInputs[path] = value
  write(path, number * scale)
}
function displayNumber(field: { path: string; fallback: number; scale: number }) {
  if (field.path in invalidInputs && !Number.isFinite(read(field.path))) return invalidInputs[field.path]
  const value = read(field.path)
  return value === undefined ? field.fallback : typeof value === 'number' ? value / field.scale : String(value)
}
const errors = computed(() => {
  const result: Record<string, string> = {}
  const parsed = SettingsFilesPolicySchema.safeParse(props.draft.files ?? {})
  if (!parsed.success) for (const issue of parsed.error.issues) result[issue.path.join('.')] = '请输入此字段允许范围内的整数。'
  const c = props.draft.files?.context
  if ((c?.maxExtractedChars ?? 80000) < (c?.maxExtractedCharsPerAsset ?? 20000)) result['context.maxExtractedChars'] = '总字符上限不能小于单文件上限。'
  if ((image.value.maxTotalDescriptionChars ?? 6000) < (image.value.maxDescriptionChars ?? 600)) result['imageContext.maxTotalDescriptionChars'] = '总字符上限不能小于单图上限。'
  return result
})
const turnsTip = computed(() => {
  const n = image.value.recentUserTurns ?? 3
  return `含首次发送轮。${Number.isInteger(n) && n > 0 ? `设为 ${n} 时，第 ${n + 1} 轮起改用文字说明；` : ''}仍可重新引用图片。不会删除历史文件。设为 1 相当于仅当前轮。`
})
function select(path: string, event: Event) {
  const value = (event.target as HTMLSelectElement).value
  if (path === 'imageContext.mode' && value !== 'recent' && errors.value['imageContext.recentUserTurns']) {
    write('imageContext.recentUserTurns', undefined)
    delete invalidInputs['imageContext.recentUserTurns']
  }
  write(path, value)
}
function numericError(field: { path: string; min: number }) {
  if (!errors.value[field.path]) return ''
  const max = ({ 'imageContext.recentUserTurns': 10000, 'imageContext.maxDescriptionChars': 4000, 'imageContext.maxTotalDescriptionChars': 40000, 'imageAdaptation.quality': 100 } as Record<string, number>)[field.path]
  return errors.value[field.path] === '请输入此字段允许范围内的整数。' ? `请输入${field.min}${max ? `—${max}` : ' 或更大'}的整数。` : errors.value[field.path]
}
function leaveTip(event: MouseEvent) {
  if (!(event.currentTarget as HTMLElement).matches(':focus')) tipOpen.turns = false
}
</script>
<template>
  <h3>{{ no }} · 文件与上下文</h3>
  <p>只影响后续请求，不删除历史文件。沿用设置底栏统一保存；保存策略不会调用识图服务。</p>
  <div class="policy-fields" @pointerdown.stop @wheel.stop>
    <fieldset v-for="group in groups" :key="group.key">
      <legend>{{ group.label }}</legend>
      <template v-if="group.key === 'image'">
        <label>自动携带 <span v-if="image.mode === undefined" class="default">默认</span>
          <select :value="image.mode ?? 'recent'" @change="select('imageContext.mode', $event)"><option value="current">仅当前轮</option><option value="recent">最近若干轮</option><option value="unlimited">不按轮数过滤</option></select>
        </label>
        <p v-if="image.mode === 'unlimited'">仍受文件大小、请求预算和整体上下文压缩限制。</p>
        <label>到期后的文字 <span v-if="image.replacement === undefined" class="default">默认</span>
          <select :value="image.replacement ?? 'description'" @change="select('imageContext.replacement', $event)"><option value="description">简短描述与关键词</option><option value="keywords">仅关键词</option></select>
        </label>
        <label>缺少描述时 <span v-if="image.missingDescription === undefined" class="default">默认</span>
          <select :value="image.missingDescription ?? 'existing'" @change="select('imageContext.missingDescription', $event)"><option value="existing">只使用已有信息</option><option value="inspect">自动调用指定识图服务补充</option></select>
        </label>
        <template v-if="image.missingDescription === 'inspect'">
          <label>补描述服务
            <select :value="image.serviceId ?? ''" :aria-invalid="!!serviceError" :aria-describedby="`${id}-service-error`" @change="select('imageContext.serviceId', $event)">
              <option value="">请选择图片理解服务</option>
              <option v-if="image.serviceId && !services.some(([key]) => key === image.serviceId)" :value="image.serviceId" disabled>{{ image.serviceId }}（不可用）</option>
              <option v-for="[key, service] in services" :key="key" :value="key">{{ service.name }} · {{ key }}</option>
            </select>
          </label>
          <p>需要时会调用所选识图服务，费用以服务方为准。执行前仍会检查连接和权限。</p>
          <p v-if="!services.length">暂无已启用图片理解操作的服务，请先在“器官 → 文件服务”中配置。</p>
          <p v-if="serviceError" :id="`${id}-service-error`" class="error" role="alert">{{ serviceError }}</p>
        </template>
      </template>
      <template v-for="field in group.fields" :key="field.path">
        <div v-if="field.path !== 'imageContext.recentUserTurns' || (image.mode ?? 'recent') === 'recent'" class="field">
          <div class="field-label"><label :for="`${id}-${field.path}`">{{ field.label }} <span v-if="read(field.path) === undefined" class="default">默认</span></label>
            <el-tooltip v-if="field.path === 'imageContext.recentUserTurns'" :visible="tipOpen.turns" :content="turnsTip" placement="top" popper-class="label-tip-popper">
              <button type="button" class="info" aria-label="了解图片保留轮数" :aria-expanded="tipOpen.turns" @click="tipOpen.turns = true" @focus="tipOpen.turns = true" @blur="tipOpen.turns = false" @mouseenter="tipOpen.turns = true" @mouseleave="leaveTip" @keydown.esc.stop="tipOpen.turns = false"><InfoFilled aria-hidden="true" /></button>
            </el-tooltip>
          </div>
          <input :id="`${id}-${field.path}`" type="text" inputmode="numeric" :value="displayNumber(field)" :aria-invalid="!!errors[field.path]" :aria-describedby="errors[field.path] ? `${id}-${field.path}-error` : undefined" @input="writeNumber(field.path, ($event.target as HTMLInputElement).value, field.scale)" />
          <p v-if="errors[field.path]" :id="`${id}-${field.path}-error`" class="error" role="alert">{{ numericError(field) }}</p>
        </div>
      </template>
      <label v-if="group.key === 'adapt'">默认图片版本 <span v-if="!draft.files?.context?.defaultImageVariant" class="default">默认</span><select :value="draft.files?.context?.defaultImageVariant ?? 'adapted'" @change="select('context.defaultImageVariant', $event)"><option value="adapted">适配版本（存在时采用，否则原始）</option><option value="original">原始文件</option></select></label>
    </fieldset>
  </div>
</template>
<style scoped>
h3 { font-size:14px; font-weight:600; margin:0; }
p { margin:0; font-size:14px; line-height:1.5; white-space:pre-wrap; overflow-wrap:anywhere; }
.policy-fields { display:flex; flex-direction:column; gap:16px; min-width:0; }
fieldset { border:0; border-top:1px solid var(--border); margin:0; padding:12px 0 0; min-width:0; display:flex; flex-direction:column; gap:12px; }
legend { padding:0 6px 0 0; font-size:14px; font-weight:600; }
label,.field { display:flex; flex-direction:column; gap:5px; font-size:14px; min-width:0; }
.field-label { display:flex; align-items:center; gap:6px; } .field-label label { display:block; }
.default { font-size:14px; color:var(--info); } .error { color:var(--danger); }
input,select { width:100%; box-sizing:border-box; min-width:0; max-width:100%; border:1px solid var(--border-strong); background:var(--surface); color:var(--ink); border-radius:0; font:inherit; padding:6px; }
.info { display:inline-flex; align-items:center; justify-content:center; flex:none; width:28px; height:28px; border:0; padding:5px; color:var(--info); background:transparent; cursor:help; } .info svg { width:16px; height:16px; }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>
