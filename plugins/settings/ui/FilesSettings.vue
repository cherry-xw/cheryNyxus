<script setup lang="ts">
import { onMounted, ref, computed } from 'vue'
import { SettingsFilesPolicySchema } from '../../../packages/protocol/src/settings'
import { DEFAULT_FILES_CONFIG } from '../../../packages/protocol/src/settingsDefaults'
import { managerRequest, ManagerApiError } from '../../../packages/manager-ui/src/api'
import { requestId } from '../../../packages/manager-ui/src/requestId'
const endpoint = '/api/modules/capabilities/files'
const policy = ref<Record<string, any>>({})
const revision = ref(''); const busy = ref(false); const message = ref(''); const uncertain = ref(false)
const fields = [
  ['maxBytes', '单图硬上限（字节；5 MB = 5,000,000 字节，不是目标体积）', DEFAULT_FILES_CONFIG.imageAdaptation.maxBytes],
  ['maxEdge', '适配最长边（像素）', DEFAULT_FILES_CONFIG.imageAdaptation.maxEdge],
  ['quality', 'JPEG/WebP 编码质量上限（1—100）', DEFAULT_FILES_CONFIG.imageAdaptation.quality],
] as const
async function load() {
  busy.value = true
  try {
    const r = await managerRequest<{ data: { policy: typeof policy.value; baseRevision: string } }>(endpoint)
    policy.value = SettingsFilesPolicySchema.parse(r.data.policy); revision.value = r.data.baseRevision; uncertain.value = false
  } catch (e) { message.value = e instanceof Error ? e.message : '读取失败' }
  finally { busy.value = false }
}
function change(key: string, event: Event) {
  policy.value.imageAdaptation ??= {}
  const value = (event.target as HTMLInputElement).value
  if (!value.trim()) delete policy.value.imageAdaptation[key]
  else policy.value.imageAdaptation[key] = Number(value)
}
function changeDrawingCount(event: Event) {
  const text = (event.target as HTMLInputElement).value
  if (!text) reset('imageGeneration', 'defaultCount')
  else policy.value.imageGeneration = { ...policy.value.imageGeneration, defaultCount: Number(text) }
}
function reset(group: string, key: string) {
  if (!policy.value[group]) return
  delete policy.value[group][key]
  if (!Object.keys(policy.value[group]).length) delete policy.value[group]
}
const errors = computed(() => { const result = SettingsFilesPolicySchema.safeParse(policy.value); return result.success ? '' : result.error.issues.map(issue => `files.${issue.path.join('.')}: ${issue.message}`).join('\n') })
async function save() {
  if (errors.value) { message.value = errors.value; return }
  busy.value = true; message.value = ''
  try {
    const parsed = SettingsFilesPolicySchema.parse(policy.value)
    const response = await managerRequest<{ data: { policy: typeof policy.value; baseRevision: string } }>(endpoint, { method: 'PUT', body: JSON.stringify({ policy: parsed, expectedBaseRevision: revision.value, requestId: requestId() }) })
    const after = await managerRequest<{ data: { policy: typeof policy.value; baseRevision: string } }>(endpoint)
    if (after.data.baseRevision !== response.data.baseRevision || JSON.stringify(after.data.policy) !== JSON.stringify(parsed)) throw new Error('保存后配置已变化，请重新读取')
    policy.value = after.data.policy; revision.value = after.data.baseRevision; message.value = '已保存并回读，影响后续请求'
  } catch (e) { uncertain.value = !(e instanceof ManagerApiError) || ![400, 401, 403, 404, 409, 422].includes(e.status); message.value = e instanceof Error ? e.message : '保存未确认，请重新读取核对' }
  finally { busy.value = false }
}
onMounted(load)
</script>
<template>
  <article class="capability-block">
    <h2>图片设置</h2>
    <p>与 Web 文件设置共用后端配置。原件保留；压缩可能损失细节。无法保留动画或满足硬上限时不携带，不自动取首帧。</p>
    <details><summary>编码质量上限说明</summary><p>合规原图直接复用；仅转换或压缩时使用编码质量上限，仍超限会继续降质或等比缩小。它不是原图视觉质量；JPEG/WebP 同值不表示视觉等价，PNG 无有损 quality 参数。不放大小图补体积。</p></details>
    <fieldset :disabled="busy || !revision || uncertain">
      <label v-for="[key, label, fallback] in fields" :key="key">{{ label }}<input type="text" inputmode="numeric" :value="policy.imageAdaptation?.[key] ?? fallback" :aria-invalid="!!errors" aria-describedby="manager-files-error" @change="change(key, $event)" /><small>{{ policy.imageAdaptation?.[key] === undefined ? '项目默认' : '手动设置' }}</small><button v-if="policy.imageAdaptation?.[key] !== undefined" type="button" @click="reset('imageAdaptation', key)">恢复默认</button></label>
      <label>全局默认绘图张数<input type="text" inputmode="numeric" :value="policy.imageGeneration?.defaultCount ?? DEFAULT_FILES_CONFIG.imageGeneration.defaultCount" :aria-invalid="!!errors" aria-describedby="manager-files-error" @change="changeDrawingCount" /><button v-if="policy.imageGeneration?.defaultCount !== undefined" type="button" @click="reset('imageGeneration', 'defaultCount')">恢复默认</button></label>
      <p v-if="errors" id="manager-files-error" role="alert">{{ errors }}</p>
      <button type="button" @click="save">保存图片设置</button>
    </fieldset>
    <button type="button" :disabled="busy" @click="load">重新读取</button>
    <p role="status">{{ message }}</p>
  </article>
</template>
