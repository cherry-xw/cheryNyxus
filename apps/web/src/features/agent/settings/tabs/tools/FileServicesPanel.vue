<script setup lang="ts">
import { computed, ref } from 'vue'
import { FILE_SERVICE_ADAPTER_CATALOG, SettingsFileServiceSchema, buildFileServiceToolName } from '@chery/protocol'
import type { ConfigDto, FileServiceConfigDto, FileServiceAdapterId, FileCapabilityOperation } from '@/application/backend/public'
import { FILE_OPERATION_LABELS } from '../../model/fileServices'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import FileServiceTrial from './FileServiceTrial.vue'
import FileServiceParameterFields from './FileServiceParameterFields.vue'

const props = defineProps<{ draft: ConfigDto }>()
const selected = ref('')
const search = ref('')
const message = ref('')
const showTrial = ref(false)
const current = computed(() => props.draft.file_services?.[selected.value])
const catalog = computed(() => FILE_SERVICE_ADAPTER_CATALOG.find(a => a.id === current.value?.adapter))
const entries = computed(() => Object.entries(props.draft.file_services ?? {}).filter(([, s]) => `${s.name} ${s.adapter} ${s.connection.model} ${s.operations.map(o => FILE_OPERATION_LABELS[o]).join(' ')}`.toLowerCase().includes(search.value.toLowerCase())))
const usedBy = computed(() => Object.entries(props.draft.sense_groups ?? {}).filter(([, tools]) => current.value?.operations.some(op => tools.some(t => t.split(':')[0] === buildFileServiceToolName(selected.value, op)))).map(([name]) => name))
function add(adapter: FileServiceAdapterId = 'openai-images') {
  const id = `svc_${crypto.randomUUID().replaceAll('-', '_')}`
  const definition = FILE_SERVICE_ADAPTER_CATALOG.find(a => a.id === adapter)!
  props.draft.file_services ??= {}
  props.draft.file_services[id] = { name: '新文件服务', enabled: true, adapter, connection: {}, operations: [definition.supportedOperations[0]!], defaults: {} }
  selected.value = id
  message.value = ''
}
function duplicate() {
  if (!current.value) return
  const copy = JSON.parse(JSON.stringify(current.value)) as FileServiceConfigDto
  add(copy.adapter)
  props.draft.file_services![selected.value] = { ...copy, name: `${copy.name} 副本` }
}
function remove() {
  if (!props.draft.file_services) return
  delete props.draft.file_services[selected.value]
  selected.value = Object.keys(props.draft.file_services)[0] ?? ''
  message.value = '服务已从草稿移除；保存前请修正工具组及角色中的引用。'
}
function changeAdapter(value: Event) {
  if (!current.value) return
  const adapter = (value.target as HTMLSelectElement).value as FileServiceAdapterId
  const def = FILE_SERVICE_ADAPTER_CATALOG.find(a => a.id === adapter)!
  current.value.adapter = adapter
  current.value.operations = [def.supportedOperations[0]!]
  current.value.defaults = {}
  current.value.connection.endpointOverrides = undefined
  current.value.toolMapping = adapter === 'custom-sense-mcp' ? { toolName: '', inputAssetField: 'assets', questionField: 'prompt', transferMode: 'data-url' } : undefined
  if (adapter === 'vision-brain') current.value.connection = { brainRef: Object.keys(props.draft.llm.brain)[0] ?? '' }
  message.value = '已切换接口；不适用的操作、默认参数和完整端点覆盖已移除，请检查连接。'
}
function updateMappingConstants(event: Event) {
  try {
    const value: unknown = JSON.parse((event.target as HTMLTextAreaElement).value || '{}')
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('固定参数必须是 JSON 对象')
    current.value!.toolMapping!.constantParams = value as Record<string, unknown>
    message.value = ''
  } catch (error) { message.value = error instanceof Error ? error.message : '固定参数无效' }
}
function operation(op: FileCapabilityOperation, enabled: boolean) {
  if (!current.value) return
  current.value.operations = enabled ? [...current.value.operations, op] : current.value.operations.filter(o => o !== op)
}
function validate() {
  const parsed = SettingsFileServiceSchema.safeParse(current.value)
  message.value = parsed.success ? '配置结构检查通过，尚未调用服务；权限及引用在统一保存时检查。' : parsed.error.issues.map(i => `${i.path.join('.')}：${i.message}`).join('\n')
}
function updateDefaults(event: Event) {
  try {
    const value: unknown = JSON.parse((event.target as HTMLTextAreaElement).value)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('请输入 JSON 对象')
    current.value!.defaults = value as Record<string, unknown>
    message.value = ''
  } catch (e) { message.value = e instanceof Error ? e.message : '默认参数无效' }
}
function connectionMode(event: Event) {
  if (!current.value) return
  current.value.connection = (event.target as HTMLSelectElement).value === 'brain' ? { brainRef: Object.keys(props.draft.llm.brain)[0] ?? '' } : {}
}
function assign(group: string) {
  const tools = props.draft.sense_groups?.[group]
  if (!tools || !current.value) return
  for (const op of current.value.operations) {
    const name = buildFileServiceToolName(selected.value, op)
    if (!tools.some(t => t.split(':')[0] === name)) tools.push(name)
  }
  message.value = `已分配到「${group}」草稿；角色仍按器官组和行为权限使用。`
}
</script>

<template>
  <section class="file-services" aria-label="文件服务">
    <aside>
      <label>查找文件服务<input v-model="search" type="search" /></label>
      <button type="button" @click="add()">添加服务</button>
      <p v-if="!entries.length">还没有匹配的文件服务。服务用于理解或生成文件。</p>
      <button v-for="[id, service] in entries" :key="id" type="button" :aria-pressed="selected === id" @click="selected = id; showTrial = false; message = ''">
        {{ service.name }}<small>{{ service.connection.model || service.connection.brainRef || service.adapter }} · {{ service.enabled === false ? '已停用' : '已启用' }}</small>
      </button>
    </aside>
    <div v-if="current" class="service-editor">
      <div class="actions"><button type="button" @click="duplicate">复制服务</button><ConfirmPopover title="移除此文件服务？已有工具组和角色引用需在本次保存时修正。" @confirm="remove"><template #trigger><button type="button">删除服务</button></template></ConfirmPopover></div>
      <label>名称<input v-model="current.name" required /></label>
      <label><input v-model="current.enabled" type="checkbox" />启用服务</label>
      <label>接口类型<select :value="current.adapter" @change="changeAdapter"><option v-for="a in FILE_SERVICE_ADAPTER_CATALOG" :key="a.id" :value="a.id">{{ a.label }}</option></select></label>
      <p>切换接口会移除不适用的操作、默认参数和完整端点覆盖，不会调用服务。</p>
      <h3>连接</h3>
      <template v-if="current.adapter === 'custom-sense-mcp' && current.toolMapping">
        <label>已有工具名称<input v-model="current.toolMapping.toolName" placeholder="工具名称或 mcp__服务名__工具名" required /></label>
        <label>文件参数名<input v-model="current.toolMapping.inputAssetField" required /></label>
        <label>问题参数名<input v-model="current.toolMapping.questionField" required /></label>
        <label>文件传递方式<select v-model="current.toolMapping.transferMode"><option value="data-url">包含文件类型的 base64</option><option value="base64">base64 文件内容</option><option value="asset-id">本地资产 ID（仅限本地工具）</option></select></label>
        <label>固定参数（JSON 对象）<textarea :value="JSON.stringify(current.toolMapping.constantParams ?? {}, null, 2)" rows="4" spellcheck="false" @change="updateMappingConstants" /></label>
        <label>文字结果路径（可留空）<input v-model="current.toolMapping.resultPath" placeholder="例如 data.text" /></label>
        <p>文件参数按数组传递。文件结果必须由工具返回结构化文件引用；映射不增加角色权限，也不会跳过底层工具审批。</p>
      </template>
      <template v-else>
      <label>连接来源<select :value="current.connection.brainRef !== undefined ? 'brain' : 'independent'" @change="connectionMode"><option value="independent">独立连接</option><option value="brain">复用已有大脑</option></select></label>
      <label v-if="current.connection.brainRef !== undefined">大脑<select v-model="current.connection.brainRef"><option v-for="(_, name) in draft.llm.brain" :key="name" :value="name">{{ name }}</option></select></label>
      <template v-else>
        <label>基础地址<input v-model="current.connection.baseUrl" type="url" /></label>
        <label>模型或接入点<input v-model="current.connection.model" :list="`models-${selected}`" /><datalist :id="`models-${selected}`"><option v-for="m in catalog?.representativeModels" :key="m" :value="m" /></datalist></label>
        <label>认证方式<select v-model="current.connection.authType"><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="query-key">Query key</option><option value="none">无需认证</option></select></label>
        <label v-if="current.connection.authType !== 'none'">密钥引用（$ENV）<input v-model="current.connection.keyRef" placeholder="$IMAGE_API_KEY" autocomplete="off" /></label>
      </template>
      </template>
      <h3>启用操作</h3>
      <label v-for="op in catalog?.supportedOperations" :key="op"><input type="checkbox" :checked="current.operations.includes(op)" @change="operation(op, ($event.target as HTMLInputElement).checked)" />{{ current.adapter === 'minimax-images' && op === 'image.reference' ? '人物参考生成' : FILE_OPERATION_LABELS[op] }}</label>
      <details><summary>高级完整端点覆盖</summary><label v-for="op in current.operations" :key="op">{{ FILE_OPERATION_LABELS[op] }} 完整地址<input type="url" :value="current.connection.endpointOverrides?.[op]" @change="current.connection.endpointOverrides = { ...current.connection.endpointOverrides, [op]: ($event.target as HTMLInputElement).value || undefined }" /></label><p>填写后此操作不再拼接基础地址路径。</p></details>
      <h3>默认参数</h3>
      <FileServiceParameterFields :adapter="current.adapter" :model-value="current.defaults ?? {}" @update:model-value="current.defaults = $event" />
      <details><summary>直接编辑参数（JSON）</summary><label>仅填写该接口及型号支持的参数<textarea :value="JSON.stringify(current.defaults ?? {}, null, 2)" rows="6" spellcheck="false" @change="updateDefaults" /></label><p>未填写的参数由服务决定；未知字段会在保存或调用时报告。</p></details>
      <h3>执行限制</h3>
      <label>排队最长等待（分钟）<input type="number" min="0.01" :value="(current.queueTimeoutMs ?? 600000) / 60000" @change="current.queueTimeoutMs = Number(($event.target as HTMLInputElement).value) * 60000" /></label>
      <label>开始执行后超时（分钟）<input type="number" min="0.01" :value="(current.timeoutMs ?? 600000) / 60000" @change="current.timeoutMs = Number(($event.target as HTMLInputElement).value) * 60000" /></label>
      <label>最大并发数<input v-model.number="current.maxConcurrent" type="number" min="1" placeholder="2" /></label>
      <h3>分配与使用</h3><p>{{ usedBy.length ? `器官组：${usedBy.join('、')}` : '尚未分配给器官组，角色不会因此自动获得工具。' }}</p>
      <label>分配已启用操作到器官组<select value="" @change="assign(($event.target as HTMLSelectElement).value)"><option value="" disabled>选择器官组</option><option v-for="(_, group) in draft.sense_groups" :key="group" :value="group">{{ group }}</option></select></label>
      <div class="actions"><button type="button" @click="validate">检查配置</button><button type="button" :aria-expanded="showTrial" @click="showTrial = !showTrial">{{ showTrial ? '收起试用' : '打开试用' }}</button></div>
      <pre v-if="message" role="status">{{ message }}</pre>
      <FileServiceTrial v-if="showTrial" :key="selected" :service-id="selected" :service="current" />
    </div>
    <p v-else>选择或添加服务后编辑；所有修改由设置底栏统一保存。</p>
  </section>
</template>

<style scoped>
.file-services { display:grid; grid-template-columns:minmax(170px,24%) minmax(0,1fr); gap:16px; color:var(--ink); font-size:14px; container-type:inline-size; }
aside,.service-editor { display:flex; flex-direction:column; gap:12px; min-width:0; }
aside { border-right:1px solid var(--border); padding-right:12px; }
label { display:flex; flex-direction:column; gap:5px; } label:has(input[type=checkbox]) { flex-direction:row; align-items:center; }
input,select,textarea,button { font:inherit; color:var(--ink); background:var(--surface); border:1px solid var(--border-strong); border-radius:0; padding:7px; min-width:0; }
button { cursor:pointer; text-align:left; } button[aria-pressed=true] { border-color:var(--accent); background:var(--accent-soft); }
small { display:block; font-size:12px; overflow-wrap:anywhere; } p { margin:0; line-height:1.5; } h3 { margin:8px 0 0; font-size:14px; font-weight:600; border-top:1px solid var(--border); padding-top:12px; }
.actions { display:flex; flex-wrap:wrap; gap:8px; } pre { white-space:pre-wrap; overflow-wrap:anywhere; font:inherit; } :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
@container (max-width:560px) { .file-services { grid-template-columns:1fr; } }
@media (max-width:650px) { .file-services { grid-template-columns:1fr; } aside { border-right:0; border-bottom:1px solid var(--border); padding-bottom:12px; } }
</style>
