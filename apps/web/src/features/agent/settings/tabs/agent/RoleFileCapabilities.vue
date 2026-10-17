<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { FILE_CAPABILITY_OPERATIONS } from '@chery/protocol'
import type { ConfigDto, FileCapabilityOperation, RoleFileCapabilityModeDto } from '@/application/backend/public'
import { fileApi } from '@/application/files/public'
import { FILE_OPERATION_LABELS, fileServiceTools } from '../../model/fileServices'
const props = defineProps<{ draft: ConfigDto; roleName: string; preset?: string; disabled?: boolean }>()
const local = ref(!!props.preset)
const busy = ref(false)
const error = ref('')
const resolutions = ref<Awaited<ReturnType<typeof fileApi.resolve>>['capabilities']>([])
const role = computed(() => props.draft.roles?.[props.roleName])
const preset = computed(() => props.preset ? props.draft.presets?.[props.preset] : undefined)
const bindings = computed(() => local.value && preset.value ? preset.value.roleOverrides?.[props.roleName]?.fileCapabilities : role.value?.fileCapabilities)
const candidates = computed(() => fileServiceTools(props.draft))
const members = computed(() => preset.value?.roles ?? [])
function set(op: FileCapabilityOperation, mode: RoleFileCapabilityModeDto, targetId?: string) {
  if (!role.value || (props.disabled && !local.value)) return
  const owner = role.value
  if (local.value && preset.value) {
    preset.value.roleOverrides ??= {}
    const override = preset.value.roleOverrides[props.roleName] ??= {}
    override.fileCapabilities ??= {}
    override.fileCapabilities[op] = { mode, ...(targetId ? { targetId } : {}), fallback:'none' }
  } else {
    owner.fileCapabilities ??= {}
    owner.fileCapabilities[op] = { mode, ...(targetId ? { targetId } : {}), fallback:'none' }
  }
}
function reset(op: FileCapabilityOperation) { if (bindings.value) delete bindings.value[op] }
async function resolve() {
  busy.value = true; error.value = ''
  const snapshot = JSON.stringify(props.draft)
  const roleName = props.roleName
  const presetName = props.preset
  try {
    const response = await fileApi.resolve({ roleName:props.roleName, roleId:role.value?.id, preset:props.preset, draft:JSON.parse(snapshot) })
    if (roleName === props.roleName && presetName === props.preset && snapshot === JSON.stringify(props.draft)) resolutions.value = response.capabilities
  } catch (e) { if (roleName === props.roleName && presetName === props.preset) error.value = e instanceof Error ? e.message : '无法检查实际能力' }
  finally { busy.value = false }
}
watch(() => [props.roleName, JSON.stringify(props.draft)], () => { resolutions.value = [] })
const status: Record<string,string> = { available:'配置可用，服务调用尚未验证', requires_approval:'需要批准', selection_required:'需要选择处理对象', unavailable:'不可用', unknown:'尚未确认' }
</script>
<template>
  <section class="role-files">
    <h3>文件处理方式</h3>
    <label v-if="preset">编辑范围<select v-model="local"><option :value="true">仅当前预设（缺省继承角色默认）</option><option :value="false">角色默认（影响所有引用处）</option></select></label>
    <p>指定对象不等于授予权限；工具仍需分配到角色器官组，委派仍受当前预设和行为权限限制。</p>
    <div v-for="op in FILE_CAPABILITY_OPERATIONS" :key="op" class="capability-row">
      <span>{{ FILE_OPERATION_LABELS[op] }}</span>
      <label>处理方式<select :disabled="disabled && !local" :value="bindings?.[op]?.mode ?? 'auto'" @change="set(op, ($event.target as HTMLSelectElement).value as RoleFileCapabilityModeDto)"><option value="auto">自动</option><option value="native">模型直接处理</option><option value="tool">指定工具</option><option value="role">指定角色</option><option value="disabled">关闭</option></select></label>
      <label v-if="bindings?.[op]?.mode === 'tool'">工具<select :disabled="disabled && !local" :value="bindings?.[op]?.targetId ?? ''" @change="set(op, 'tool', ($event.target as HTMLSelectElement).value)"><option value="">请选择</option><option v-for="tool in candidates.filter(t => t.operations.includes(op))" :key="tool.name" :value="tool.name">{{ tool.label }}</option><option v-if="bindings?.[op]?.targetId && !candidates.some(t => t.name === bindings?.[op]?.targetId)" :value="bindings?.[op]?.targetId">{{ bindings?.[op]?.targetId }}（不在当前文件服务目录，请检查）</option></select></label>
      <label v-if="bindings?.[op]?.mode === 'role'">委派角色<select :disabled="disabled && !local" :value="bindings?.[op]?.targetId ?? ''" @change="set(op, 'role', ($event.target as HTMLSelectElement).value)"><option value="">请选择</option><option v-for="name in members.filter(n => n !== roleName)" :key="name" :value="draft.roles?.[name]?.id ?? name">{{ name }}</option></select></label>
      <button v-if="bindings?.[op]" type="button" :disabled="disabled && !local" @click="reset(op)">{{ local ? '恢复角色默认' : '恢复自动' }}</button>
      <p v-for="r in resolutions.filter(r => r.operation === op)" :key="r.operation">{{ status[r.availability] ?? r.availability }} · {{ r.reason || r.source }}</p>
    </div>
    <button type="button" :disabled="busy" @click="resolve">{{ busy ? '检查中…' : '检查草稿实际能力（不调用模型）' }}</button>
    <p v-if="error" role="alert">{{ error }}</p>
    <p>文件服务及工具分配在「器官 → 文件服务」编辑；切页保留全部设置草稿。</p>
  </section>
</template>
<style scoped>
.role-files { display:flex; flex-direction:column; gap:12px; font-size:14px; color:var(--ink); margin:16px 0; border-top:1px solid var(--border); padding-top:12px; } h3 { margin:0; font-size:14px; font-weight:600; } p { margin:0; line-height:1.5; overflow-wrap:anywhere; } label { display:flex; flex-direction:column; gap:5px; min-width:0; } .capability-row { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:8px 0; border-bottom:1px solid var(--border); } .capability-row p { flex-basis:100%; } select,button { border:1px solid var(--border-strong); background:var(--surface); color:var(--ink); border-radius:0; padding:7px; font:inherit; min-width:0; max-width:100%; } :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>
