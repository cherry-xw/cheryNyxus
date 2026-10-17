<script setup lang="ts">
import type { FileServiceConfigDto } from '@/application/backend/public'
import { FILE_OPERATION_LABELS } from '../../model/fileServices'
import MessageParts from '../../../chat/MessageParts.vue'
import FileOperationSummary from '../../../chat/FileOperationSummary.vue'
import FileServiceParameterFields from './FileServiceParameterFields.vue'
import ConfirmPopover from '@/components/confirm/ConfirmPopover.vue'
import { useFileServiceTrial } from './useFileServiceTrial'
const props = defineProps<{ serviceId: string; service: FileServiceConfigDto }>()
const { operation, prompt, trialParams, assets, record, error, busy, previousTrials, stale, active, saving, upload, run, selectTrial, restoreRequest, removeTrial } = useFileServiceTrial(props)
</script>
<template>
  <section class="trial" aria-label="文件服务试用" :aria-busy="busy">
    <h3>试用（不保存配置）</h3>
    <label v-if="previousTrials.length">历史试用<select :value="record?.operationId" :disabled="busy" @change="selectTrial(($event.target as HTMLSelectElement).value)"><option v-for="item in previousTrials" :key="item.operationId" :value="item.operationId">{{ new Date(item.createdAt).toLocaleString() }} · {{ FILE_OPERATION_LABELS[item.operation] }}</option></select></label>
    <label>操作<select v-model="operation" :disabled="busy"><option v-for="op in service.operations" :key="op" :value="op">{{ FILE_OPERATION_LABELS[op] }}</option></select></label>
    <label>提示或问题<textarea v-model="prompt" rows="3" :disabled="busy" /></label>
    <details><summary>本次参数（不修改默认值）</summary><FileServiceParameterFields v-model="trialParams" :adapter="service.adapter" /></details>
    <label>参考文件<input type="file" multiple :disabled="busy" @change="upload" /></label>
    <ul><li v-for="(asset, index) in assets" :key="`${asset.versionId}:${index}`">{{ asset.originalName }} <button type="button" :disabled="busy" :aria-label="`移除参考文件 ${asset.originalName}`" @click="assets.splice(index, 1)">移除</button></li></ul>
    <p>测试使用当前表单配置并调用真实服务，可能产生费用。关闭面板不会停止操作，重新打开可以查询记录。</p>
    <button type="button" :disabled="busy || active || saving || !prompt.trim()" @click="run('try')">{{ operation === 'image.inspect' ? '测试图片理解（可能收费）' : '发起新的服务测试（可能收费）' }}</button>
    <p v-if="stale">当前显示的是先前试用结果，不代表当前表单已通过测试。</p>
    <template v-if="record">
      <FileOperationSummary :operations="[record]" />
      <button type="button" :disabled="busy" @click="run('refresh')">查询状态</button>
      <button type="button" :disabled="busy" @click="restoreRequest">载入此记录的输入（不调用服务）</button>
      <ConfirmPopover v-if="!active && !saving" title="删除此试用记录？其文件在没有其他引用后会按保留策略清理。" @confirm="removeTrial"><template #trigger><button type="button" :disabled="busy">删除试用记录</button></template></ConfirmPopover>
      <button v-if="active" type="button" :disabled="busy" @click="run('cancel')">停止操作</button>
      <button v-if="record.deliveryStatus === 'delivery_failed' || record.deliveryStatus === 'partial_saved'" type="button" :disabled="busy || active" @click="run('save')">重试保存结果（不重新生成）</button>
      <MessageParts v-if="record.outputParts" :parts="record.outputParts" />
    </template>
    <p v-if="error" role="alert">{{ error }}</p>
  </section>
</template>
<style scoped>
.trial { display:flex; flex-direction:column; gap:10px; border-top:1px solid var(--border); padding-top:12px; font-size:14px; } label { display:flex; flex-direction:column; gap:5px; } input,select,textarea,button { font:inherit; color:var(--ink); background:var(--surface); border:1px solid var(--border-strong); border-radius:0; padding:7px; min-width:0; } p { margin:0; overflow-wrap:anywhere; } :focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
</style>
