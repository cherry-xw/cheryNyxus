<script setup lang="ts">
import type { SourceVisiblePart, SourceContextItem } from '../../../packages/protocol/src/sourceManagement'
import type { SourceFileProvision } from '../../../packages/protocol/src/sourceContext'
import type { useQqSources } from './useQqSources'
import SourceBody from './SourceBody.vue'
const props=defineProps<{requestId:string;parts:SourceVisiblePart[];reader:ReturnType<typeof useQqSources>;
  selection?:Extract<SourceContextItem,{type:'message'}>['partSelection'];files?:SourceFileProvision[];recordId?:string}>()
defineEmits<{relation:[id:string,event:Event]}>()
function selected(partId:string){return props.selection?.find(part=>part.partId===partId)}
function file(partId:string){
  const value=props.files?.find(file=>file.source.recordId===props.recordId&&file.source.partId===partId)
  return value?{representation:value.representation,reasonCode:'reasonCode' in value?value.reasonCode:undefined,
    readerId:value.representation==='tool_reference'?value.reader.id:undefined,
    workspaceMount:value.representation==='tool_reference'?value.workspaceMount:undefined}:undefined
}
const representation=(value?:string)=>({native:'本次请求附带文件（不表示模型已读懂）',description:'本次提供已有描述',extracted_text:'本次提供提取文字',
  tool_reference:'本次提供文件引用；等待调用读取工具',metadata_only:'本次只提供附件信息'}[value??'']??'只有采集状态；尚无本次提供记录')
</script>
<template>
  <div v-for="part in parts" :key="part.partId" class="source-part">
    <template v-if="part.type==='text'">
      <p v-if="selected(part.partId)?.mode==='summary_reference'">本次以摘要代替；以下原文未逐字进入所选输入。</p>
      <p v-else-if="selected(part.partId)?.mode==='tool_result_reference'">答案通过问题工具结果提供一次；下方为来源原文。</p>
      <SourceBody :request-id="requestId" :body="part.body" :reader="reader" />
    </template>
    <p v-else-if="part.type==='mention'">@{{ part.target==='all'?'全体成员':part.target }}</p>
    <p v-else-if="part.type==='reply'">引用消息：{{ part.result==='selected'?'已纳入所选输入':part.result==='source_only'?'未纳入所选输入':'引用来源不可用或未保留' }}
      <button type="button" @click="$emit('relation',part.relationId,$event)">查看引用来源</button></p>
    <template v-else-if="part.type==='attachment'">
      <p>附件：{{ part.originalName || part.mediaKind }} · {{ part.acquisitionState }} · {{ representation(file(part.partId)?.representation) }}</p>
      <details><summary>附件来源与提供方式</summary>
        <dl><dt>来源段</dt><dd>{{ part.partId }}</dd><dt>附件固定版本</dt><dd>{{ part.attachmentId }} / {{ part.version }}</dd></dl>
        <p v-if="file(part.partId)?.reasonCode">原因：{{ file(part.partId)?.reasonCode }}</p>
        <p v-if="files?.find(value=>value.source.partId===part.partId&&value.source.recordId===recordId&&value.representation==='description')">已有描述只代表当时保存的说明，不等于本次重新看过原图；描述正文在附加资料中单独提供。</p>
        <template v-if="file(part.partId)?.representation==='tool_reference'">
          <p>读取方式：{{ file(part.partId)?.readerId }}。文件已保存，尚不表示已解压或已读取内容。</p>
          <p v-if="file(part.partId)?.workspaceMount">容器内原件：{{ file(part.partId)?.workspaceMount?.containerPath }}<br>工作目录：{{ file(part.partId)?.workspaceMount?.cwd }}<br>解压目录：{{ file(part.partId)?.workspaceMount?.extractedDir }}</p>
        </template>
      </details>
    </template>
    <p v-else>未支持的消息段：{{ part.sourceType }} {{ part.description }}</p>
  </div>
</template>
<style scoped>.source-part{overflow-wrap:anywhere}.source-part dl{margin:4px 0}.source-part dd{margin:2px 0 4px}p{margin:4px 0}</style>
