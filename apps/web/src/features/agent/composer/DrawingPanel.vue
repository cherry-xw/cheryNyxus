<script setup lang="ts">
import { inject, nextTick, useId } from 'vue'
import { ElTooltip } from 'element-plus'
import { InfoFilled } from '@element-plus/icons-vue'
import type { DrawingTask, DrawingCandidate } from '@chery/protocol'
import { DRAWING_DRAFT } from './useDrawingDraft'
import { FILE_OPERATION_LABELS } from '../settings/model/fileServices'
import FileServiceParameterFields from '../settings/tabs/tools/FileServiceParameterFields.vue'
import DrawingTaskList from './DrawingTaskList.vue'
const drawing = inject(DRAWING_DRAFT, undefined)
const state = drawing?.state
const id = useId()
async function select(task: DrawingTask, candidate: DrawingCandidate, event: Event) {
  const inputRegion = (event.currentTarget as HTMLElement).closest('.drawing-panel')?.parentElement
  await drawing?.selectCandidate(task, candidate)
  await nextTick()
  if (drawing?.state.value.sourceCandidateId === candidate.candidateId) inputRegion?.querySelector<HTMLElement>('textarea, [contenteditable="true"]')?.focus()
}
defineProps<{ disabled?: boolean }>()
</script>
<template>
  <section v-if="drawing && state" class="drawing-panel" aria-label="会话绘图">
    <button type="button" :disabled="disabled" :aria-expanded="state.enabled" :aria-controls="`${id}-controls`" @click="drawing.open">{{ state.enabled ? '退出绘图（保留草稿）' : '绘图' }}</button>
    <div v-if="state.enabled" :id="`${id}-controls`" class="drawing-controls" :aria-busy="drawing.loading.value">
      <p v-if="!drawing.services.value.length">请先在设置 → 器官 → 文件服务中配置绘图服务，并分配给角色。</p>
      <label>绘图服务<select :value="state.serviceId" :disabled="disabled" @change="drawing.chooseService(($event.target as HTMLSelectElement).value)"><option value="">请选择</option><option v-for="[id, service] in drawing.services.value" :key="id" :value="id">{{ service.name }} · {{ service.connection.model || service.connection.brainRef }}</option></select></label>
      <label>执行角色<select v-model="state.roleId" :disabled="disabled"><option value="">由当前角色执行</option><option v-for="role in drawing.roles.value" :key="role.id" :value="role.id">委派 {{ role.name }}</option></select></label>
      <label>操作<select v-model="state.operation" :disabled="disabled"><option v-for="operation in drawing.operations.value" :key="operation" :value="operation">{{ FILE_OPERATION_LABELS[operation] }}</option></select></label>
      <p v-if="drawing.result.value">实际图片型号：{{ drawing.result.value.imageModel || '由接口决定' }} · {{ drawing.result.value.adapter }}</p>
      <p v-if="drawing.result.value?.availability !== 'available'" role="status">{{ drawing.result.value?.reason }}</p>
      <label v-if="drawing.result.value?.count.effectiveCount !== undefined">{{ drawing.result.value.count.countControl === 'maximum' ? '本次最多张数' : '本次张数' }}
        <input type="number" min="1" step="1" :value="drawing.limitError.value ? state.desiredCount : drawing.result.value.count.effectiveCount" :disabled="disabled || drawing.result.value.count.effectiveMaximum === 1" :aria-invalid="!!drawing.limitError.value" :aria-describedby="drawing.limitError.value ? `${id}-limit-error` : undefined" @change="state.desiredCount = Number(($event.target as HTMLInputElement).value)" />
      </label>
      <ElTooltip v-if="drawing.result.value" :content="`${drawing.result.value.source === 'user' ? '手动设置，尚未验证' : drawing.result.value.source === 'catalog' ? '来自所选图片型号与接口的目录' : '来自接口实现限制或未知能力'}；张数只在发送时固定，不修改全局默认。`" placement="top"><button type="button" class="info" aria-label="张数限制来源"><InfoFilled aria-hidden="true" /></button></ElTooltip>
      <button type="button" :disabled="disabled" @click="drawing.resetCount">恢复全局默认张数</button>
      <p v-if="drawing.result.value?.count.reason" role="status">{{ drawing.result.value.count.reason }}</p>
      <p v-if="drawing.loading.value" role="status">正在查询限制（不会生成）</p>
      <fieldset v-if="drawing.service.value" :disabled="disabled"><legend>本次画面参数</legend>
        <FileServiceParameterFields v-model="state.params" :inherited="drawing.service.value.defaults" :operation="state.operation" :adapter="drawing.service.value.adapter" :model="drawing.result.value?.imageModel || drawing.service.value.connection.model" primary />
        <details><summary>质量、格式等参数</summary><FileServiceParameterFields v-model="state.params" :inherited="drawing.service.value.defaults" :operation="state.operation" :adapter="drawing.service.value.adapter" :model="drawing.result.value?.imageModel || drawing.service.value.connection.model" :primary="false" /></details>
      </fieldset>
      <p v-if="drawing.limitError.value" :id="`${id}-limit-error`" role="alert">{{ drawing.limitError.value }}</p>
      <button v-if="drawing.limitError.value" type="button" @click="drawing.refreshLimits">重新读取限制（不生成）</button>
      <p v-if="state.sourceCandidateId">已选择固定版本作为修改对象；下一条反馈发送后才生成新一轮。</p>
      <p v-else-if="state.operation !== 'image.generate'">可选择图片，或在消息中说明历史图片；模型无法确定时会先询问，不会自动选最后一张。</p>
      <button v-if="state.taskId" type="button" :disabled="disabled" @click="state.taskId = undefined; state.sourceCandidateId = undefined">下一次作为新绘图任务</button>
    </div>
    <details v-if="drawing.tasks.value.length">
      <summary>候选图与用户定稿（{{ drawing.tasks.value.length }} 个任务）</summary>
      <button type="button" :disabled="drawing.busy.value" @click="drawing.refreshTasks">刷新记录（不生成）</button>
      <DrawingTaskList :tasks="drawing.tasks.value" editable :selected-id="state.sourceCandidateId" :disabled="disabled || drawing.busy.value" @select="select" @finalize="drawing.finalize" />
    </details>
    <p v-if="drawing.error.value" role="alert">{{ drawing.error.value }}</p>
    <p v-if="drawing.historyError.value" role="alert">{{ drawing.historyError.value }}</p>
  </section>
</template>
<style scoped>
.drawing-panel,.drawing-controls,.drawing-task { display:flex; flex-direction:column; gap:10px; min-width:0; color:var(--ink); font-size:14px; line-height:1.5; } .drawing-panel { max-height:50vh; overflow:auto; padding:8px 0; } .drawing-task,.candidate { border-top:1px solid var(--border); padding-top:10px; margin-top:10px; } label { display:flex; flex-direction:column; gap:5px; } h4,h5,h6,p { font:inherit; margin:0; overflow-wrap:anywhere; } h4,h5,h6 { font-weight:600; } input,select,button { font:inherit; color:var(--ink); background:var(--surface); border:1px solid var(--border-strong); padding:7px; min-width:0; } button { cursor:pointer; } button:disabled { cursor:default; } :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
fieldset { margin:0; padding:10px; min-width:0; border:1px solid var(--border); } .info { align-self:flex-start; } .info svg { width:16px; height:16px; }
</style>
