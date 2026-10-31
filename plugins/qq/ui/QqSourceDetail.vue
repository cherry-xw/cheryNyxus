<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { useQqSources } from './useQqSources'
import { sourceSelectionKey } from './useQqSources'
import { hasRangeSources, revealSourceTarget, sourceGapHeading } from './sourceNavigation'
import SourceBody from './SourceBody.vue'
import QqSourceParts from './QqSourceParts.vue'
const props=defineProps<{requestId:string;reader:ReturnType<typeof useQqSources>}>()
const current=computed(()=>props.reader.sessions[props.requestId])
const entries=computed(()=>props.reader.entries(props.requestId))
const selectedKey=computed(()=>current.value?.selection?sourceSelectionKey(current.value.selection):'')
const view=computed(()=>current.value?.views[selectedKey.value])
const relationId=ref(''),navigationError=ref(''),returnTo=ref<HTMLButtonElement>()
const relationTarget=ref<HTMLElement>()
let navigationVersion=0
function resetRelation(){navigationVersion++;relationId.value='';navigationError.value='';returnTo.value=undefined}
const relation=computed(()=>current.value?.selection?current.value.relations[`${current.value.selection.snapshotId}:${relationId.value}`]:undefined)
const time=(value?:number)=>value===undefined?'未记录':new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})
const labels:Record<string,string>={not_prepared:'尚未准备上下文。',snapshot_only:'已选消息固定；尚无模型采用记录。',not_applicable:'此任务没有模型调用。',legacy_unrecorded:'旧任务没有保存来源明细。',preparation_failed:'准备失败；未发起模型调用。'}
const attempts:Record<string,string>={prepared:'已准备，尚未调用',invoking:'调用已开始，等待结果',responded:'已获得响应',failed:'调用未完成',unknown:'调用结果未知',cancelled:'本地已取消，不代表对端未执行'}
const reasons:Record<string,string>={initial:'首次调用',tool_continue:'工具后继续',question_resume:'回答问题后继续',approval_resume:'批准后继续'}
const purposes:Record<string,string>={reply:'普通回复',reminder:'提醒',app_notification:'应用通知',error_notice:'失败说明',ack:'收件确认',progress:'进度说明'}
const deliveryStates:Record<string,string>={pending:'已登记待发送；尚无发送回执',inflight:'正在发送',sent:'发送已确认',failed:'发送失败',unknown:'发送结果未知，不自动重发'}
const summaryStates:Record<string,string>={pending:'已固定来源，尚未提交',running:'维护中，尚未提交',completed:'已提交',failed:'未完成，不替换原文',cancelled:'已取消，不替换原文'}
watch(()=>props.requestId,()=>{resetRelation();if(!props.reader.sessions[props.requestId]?.index)void props.reader.index(props.requestId)},{immediate:true})
watch(selectedKey,resetRelation,{flush:'sync'})
onBeforeUnmount(resetRelation)
async function choose(event:Event){const key=(event.target as HTMLSelectElement).value,item=entries.value.find(e=>e.projectionId===key);if(item)await props.reader.select(props.requestId,{snapshotId:item.snapshotId,projectionId:item.projectionId,modelStepId:item.modelStepId,attemptId:item.attempt?.attemptId})}
async function relationOpen(id:string,event:Event){
  const requestId=props.requestId,selection=selectedKey.value,version=++navigationVersion
  if(!relationTarget.value?.contains(event.currentTarget as Node))returnTo.value=event.currentTarget as HTMLButtonElement
  relationId.value=id;navigationError.value=''
  const reading=props.reader.sources(requestId,id)
  await revealSourceTarget(()=>relationTarget.value,()=>version===navigationVersion&&props.requestId===requestId&&selectedKey.value===selection&&relationId.value===id)
  await reading
}
const targets=new Map<string,HTMLElement>()
function target(id:string,value:unknown){if(value instanceof HTMLElement)targets.set(id,value);else targets.delete(id)}
async function jump(itemId:string){const version=++navigationVersion;navigationError.value='';try{const targetId=await props.reader.locate(props.requestId,{itemId});await revealSourceTarget(()=>targets.get(targetId),()=>version===navigationVersion)}catch(error){if(version===navigationVersion)navigationError.value=error instanceof Error?error.message:'定位失败'}}
async function back(){const target=returnTo.value;resetRelation();const version=navigationVersion;await revealSourceTarget(()=>target,()=>version===navigationVersion)}
async function refresh(){await props.reader.index(props.requestId);await props.reader.view(props.requestId,false,true)}
</script>
<template>
  <section class="source-detail" aria-label="来源与模型输入详情" :aria-busy="current?.loading">
    <div class="source-controls"><h4>来源与模型输入</h4><button type="button" :disabled="current?.loading" @click="refresh">刷新这份详情</button></div>
    <p v-if="current?.error" role="alert">{{ current.error }} <button type="button" @click="reader.index(requestId)">重试读取</button></p>
    <p v-if="!current?.index" role="status">{{ current?.loading?'正在读取目录…':'尚未读取来源。' }}</p>
    <template v-else>
      <p class="source-meta">截至 {{ time(current.index.observedAt) }}（北京时间）。只读查看不会调用模型、解压或重发消息。</p>
      <p v-if="current.index.availability!=='available'">{{ labels[current.index.availability] }}</p>
      <p v-if="current.newer">发现更新的输入版本；当前仍显示原选择。<button type="button" @click="reader.latest(requestId)">查看最新版本</button></p>
      <div v-if="entries.length" class="source-controls"><label :for="`source-step-${requestId}`">模型步骤与准备版本</label>
        <select :id="`source-step-${requestId}`" :value="current.selection?.projectionId??''" @change="choose">
          <option v-if="!current.selection?.projectionId" value="">仅看固定消息选择</option>
          <option v-for="entry in entries" :key="entry.projectionId" :value="entry.projectionId">步骤 {{ entry.stepSequence }} · {{ reasons[entry.reason] }} · 准备 {{ entry.projectionSequence }} · {{ attempts[entry.attempt?.state??'prepared'] }}</option>
        </select>
        <button type="button" v-if="current.index.nextCursor" :disabled="current.loading" @click="reader.index(requestId,true)">继续读取步骤目录</button>
      </div>
      <div class="source-columns">
      <section class="source-panel source-input" aria-label="所选模型输入">
        <h5 class="source-panel-heading">所选模型输入</h5>
        <p v-if="view?.loading" role="status">正在读取所选版本…</p>
        <p v-if="view?.error" role="alert">{{ view.error }} <button type="button" @click="reader.restart(requestId)">从这份输入开头重新读取</button></p>
        <template v-if="view?.data">
        <p class="source-meta" role="status">所选版本：{{ view.data.state==='snapshot_only'?'固定消息选择':attempts[view.data.attemptState??'prepared'] }} · {{ view.data.items.length }} / {{ view.data.total }} 项 · 时间近似排序，同秒先后不保证。</p>
        <details v-if="view.data.state==='available'"><summary>模型、预算与本次返回用量</summary>
          <p>{{ view.data.model }} · {{ view.data.protocol }} · 配置版本 {{ view.data.runtimeConfigRevision }}</p>
          <p v-if="view.data.budget">输入估算 {{ view.data.budget.estimatedTextTokens }} token · 计量 {{ view.data.budget.tokenSource }} · 有效上限 {{ view.data.budget.effectiveCeiling??'未测量' }} · 输出预留 {{ view.data.budget.outputReserve??'未记录' }} · 媒体用量未测量。</p><p v-else>未记录本版本预算。</p>
          <p>本次返回用量：输入 {{ view.data.usage?.inputTokens??'未记录' }} · 输出 {{ view.data.usage?.outputTokens??'未记录' }}。不与预检估算混算。</p>
        </details>
        <div class="source-scroll source-input-scroll" role="region" aria-label="所选模型输入内容" tabindex="0">
        <ol class="source-items"><li v-for="item in view.data.items" :key="item.itemId">
          <div class="source-item-heading">
          <h6 :ref="element=>target(item.itemId,element)" tabindex="-1">{{ item.type==='message'?`${item.sender.name||'未记录昵称'}（${item.sender.id}）`:item.type==='summary'?'历史资料摘要':item.type==='gap'?sourceGapHeading(item.reason):item.type==='data'?'附加资料':item.type==='restricted'?'内容受限':'本次工具过程' }}</h6>
          <p v-if="item.type==='message'" class="source-meta">{{ time(item.time.at) }}（{{ item.time.basis==='platform_sent'?'平台发送时间':item.time.basis==='delivery_confirmed'?'发送确认时间':'接收时间' }}） · {{ item.origin==='member'?'成员消息':'机器人真实发送' }} · {{ item.selectionReasons.map(reason=>({current:'本次输入',recent:'近期背景',explicit_quote:'明确引用'}[reason])).join('、') }}</p>
          </div>
          <template v-if="item.type==='message'">
            <QqSourceParts :request-id="requestId" :parts="item.parts" :selection="item.partSelection" :files="view.data.fileInputs" :record-id="item.source.recordId" :reader="reader" @relation="relationOpen" />
            <details><summary>来源信息</summary><p>{{ item.source.recordId }} / {{ item.source.revision }} · 平台消息 {{ item.platformMessageIds.join('、') }}</p></details>
          </template>
          <template v-else-if="item.type==='summary'"><p>{{ item.purpose==='capacity'?'容量整理':'讨论总结' }} · 已提交 · 覆盖 {{ item.coveredRecordCount }} 条来源。</p><SourceBody :request-id="requestId" :body="item.body" :reader="reader" /><button type="button" :aria-expanded="relationId===item.relationId" :aria-controls="`source-relations-${requestId}`" @click="relationOpen(item.relationId,$event)">查看摘要覆盖来源</button></template>
          <template v-else-if="item.type==='gap'"><p>{{ item.reason==='omitted_from_context'?`已保存、未纳入所选输入：${item.knownMessageCount} 条；其中 ${item.partiallySummarizedCount??0} 条部分内容已有摘要。`:item.reason==='history_start'?'本地记录从此范围起点开始；更早消息未必接收。':item.reason==='reception_unconfirmed'?'此区间接收情况未确认，数量未知。':'来源已删除。' }}</p><button v-if="hasRangeSources(item)" type="button" :aria-expanded="relationId===item.relationId" :aria-controls="`source-relations-${requestId}`" @click="relationOpen(item.relationId,$event)">查看范围来源</button></template>
          <SourceBody v-else-if="item.type==='data'" :request-id="requestId" :body="item.body" :reader="reader" />
          <p v-else-if="item.type==='tool_result'">{{ item.toolName }} · {{ item.status==='completed'?'已返回工具结果':'工具结果状态未知' }}。未登记可公开正文，不公开原始参数、思考或原始工具输出。</p>
          <p v-else>当前无权读取；不展示来源身份或文件名。</p>
        </li></ol>
        <button v-if="view.data.nextCursor" type="button" :disabled="view.loading" @click="reader.view(requestId,true)">继续读取所选输入</button>
        </div>
        </template>
      </section>
      <div class="source-support">
        <section v-if="relationId&&view?.data" :id="`source-relations-${requestId}`" ref="relationTarget" class="source-panel source-relations" tabindex="-1" aria-label="来源关系详情" :aria-busy="relation?.loading??false">
          <div class="source-controls source-panel-heading"><h5>来源关系</h5><button type="button" @click="back">返回原阅读位置</button></div>
          <div :key="relationId" class="source-scroll" role="region" aria-label="来源关系内容" tabindex="0">
          <p v-if="relation?.loading" role="status">正在读取来源关系…</p><p v-if="relation?.error" role="alert">{{ relation.error }} <button type="button" @click="reader.sources(requestId,relationId)">重试读取关系</button></p>
          <p v-if="relation?.data&&!relation.data.items.length">没有可读取的来源；不会自动查询远端 QQ。</p>
          <article v-for="item in relation?.data?.items??[]" :key="`${item.source.recordId}:${item.source.revision}`">
            <p>{{ item.includedInSelectedInput?'该消息在所选输入中；部分段可能由摘要代替。':'未纳入所选输入；此处只读来源原文。' }}</p>
            <button v-if="item.itemId" type="button" @click="jump(item.itemId)">定位所选输入中的消息</button>
            <template v-if="item.record"><p>{{ item.record.sender.name||'未记录昵称' }}（{{ item.record.sender.id }}）</p><QqSourceParts :request-id="requestId" :parts="item.record.parts" :reader="reader" @relation="relationOpen" /></template><p v-else>此来源不可读：{{ item.unavailableReason }}</p>
            <p v-if="item.evidence">摘要证据：文字段 {{ item.evidence.textPartIds.join('、')||'无' }}；附件 {{ item.evidence.attachments.map(file=>`${file.partId}: ${file.representation}`).join('、')||'无' }}。只有附件信息不表示已读取内容。</p>
          </article>
          <p v-if="navigationError" role="alert">{{ navigationError }}</p>
          <button v-if="relation?.data?.nextCursor" type="button" :disabled="relation.loading" @click="reader.sources(requestId,relationId,true)">继续读取关系来源</button>
          </div>
        </section>
      <details v-if="current.index.availability!=='legacy_unrecorded'" class="source-panel" @toggle="event=>{if((event.target as HTMLDetailsElement).open&&!current?.entryPages.messages?.data)reader.entry(requestId,'messages')}">
        <summary class="source-panel-heading">收到的本次原始消息（与模型选择分开）</summary>
        <div class="source-scroll" role="region" aria-label="本次原始消息内容" tabindex="0">
        <p v-if="current.entryPages.messages?.loading" role="status">正在读取收到的消息…</p>
        <p v-if="current.entryPages.messages?.error" role="alert">{{ current.entryPages.messages.error }} <button type="button" @click="reader.entry(requestId,'messages')">重试读取原始消息</button></p>
        <p v-if="current.entryPages.messages?.data?.total===0">未记录成员输入；提醒和应用通知不制造成员消息。</p>
        <article v-for="item in current.entryPages.messages?.data?.items??[]" :key="item.itemId"><template v-if="item.type==='message'">
          <p class="source-meta">{{ item.sender.name||'未记录昵称' }}（{{ item.sender.id }}） · {{ time(item.time.at) }}（{{ item.time.basis==='platform_sent'?'平台发送时间':item.time.basis==='delivery_confirmed'?'发送确认时间':'接收时间' }}）</p>
          <QqSourceParts :request-id="requestId" :parts="item.parts" :reader="reader" />
        </template></article>
        <button v-if="current.entryPages.messages?.data?.nextCursor" type="button" :disabled="current.entryPages.messages.loading" @click="reader.entry(requestId,'messages',true)">继续读取原始消息</button>
        </div>
      </details>
      <section v-if="current.index.generatedReply" class="source-panel" aria-label="生成的回复文字">
        <h5 class="source-panel-heading">生成的回复文字（不等于已发送）</h5>
        <div class="source-scroll" role="region" aria-label="生成回复内容" tabindex="0"><SourceBody :request-id="requestId" :body="current.index.generatedReply" :reader="reader" /></div>
      </section>
      <details v-if="current.index.availability!=='legacy_unrecorded'" class="source-panel" @toggle="event=>{if((event.target as HTMLDetailsElement).open&&!current?.entryPages.deliveries?.data)reader.entry(requestId,'deliveries')}"><summary class="source-panel-heading">完整发送记录（与生成文字分开）</summary>
        <div class="source-scroll" role="region" aria-label="完整发送记录内容" tabindex="0">
        <button type="button" :disabled="current.entryPages.deliveries?.loading" @click="reader.entry(requestId,'deliveries')">刷新发送记录</button>
        <p v-if="current.entryPages.deliveries?.loading" role="status">正在读取发送记录…</p><p v-if="current.entryPages.deliveries?.error" role="alert">{{ current.entryPages.deliveries.error }} <button type="button" @click="reader.entry(requestId,'deliveries')">重试读取发送记录</button></p>
        <p v-if="current.entryPages.deliveries?.data?.total===0">尚无发送记录。</p>
        <article v-for="item in current.entryPages.deliveries?.data?.items??[]" :key="item.itemId"><template v-if="item.type==='delivery'"><p>{{ purposes[item.purpose]??item.purpose }} · 序号 {{ item.sequence }} · {{ deliveryStates[item.status] }} · {{ time(item.confirmedAt) }}<span v-if="item.partIndex!==undefined"> · 第 {{ item.partIndex }} / {{ item.totalParts }} 段</span></p><SourceBody :request-id="requestId" :body="item.body" :reader="reader"/><p v-if="item.fileUploaded">文件上传已确认。文件 ID：{{ item.fileIds.join('、') }}</p><p v-if="item.messageIds.length">平台消息 ID：{{ item.messageIds.join('、') }}</p></template></article>
        <button v-if="current.entryPages.deliveries?.data?.nextCursor" type="button" :disabled="current.entryPages.deliveries.loading" @click="reader.entry(requestId,'deliveries',true)">继续读取发送记录</button>
        </div>
      </details>
      <details v-if="current.index.availability!=='legacy_unrecorded'" class="source-panel" @toggle="event=>{if((event.target as HTMLDetailsElement).open&&!current?.entryPages.summaries?.data)reader.entry(requestId,'summaries')}"><summary class="source-panel-heading">与本次来源有关的摘要</summary>
        <div class="source-scroll" role="region" aria-label="关联摘要内容" tabindex="0">
        <button type="button" :disabled="current.entryPages.summaries?.loading" @click="reader.entry(requestId,'summaries')">刷新摘要状态</button>
        <p v-if="current.entryPages.summaries?.loading" role="status">正在读取摘要记录…</p><p v-if="current.entryPages.summaries?.error" role="alert">{{ current.entryPages.summaries.error }}</p>
        <p v-if="current.entryPages.summaries?.data?.total===0">尚无关联摘要。原文、容量整理与讨论总结分别保存。</p>
        <article v-for="item in current.entryPages.summaries?.data?.items??[]" :key="item.itemId"><template v-if="item.type==='summary'">
          <p>{{ item.purpose==='capacity'?'容量整理':'讨论总结' }} · {{ summaryStates[item.status]??'维护状态未确认' }}<span v-if="item.reasonCode"> · 原因 {{ item.reasonCode }}</span></p>
          <SourceBody :request-id="requestId" :body="item.body" :reader="reader" />
        </template></article>
        <button v-if="current.entryPages.summaries?.data?.nextCursor" type="button" :disabled="current.entryPages.summaries.loading" @click="reader.entry(requestId,'summaries',true)">继续读取摘要记录</button>
        </div>
      </details>
      </div>
      </div>
    </template>
  </section>
</template>
<style scoped>
.source-detail { container: qq-source / inline-size; width: 100%; min-width: 0; font-size: 13px; line-height: 1.55; color: #111; }
.source-detail p { margin: 4px 0; }
.source-controls { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 10px; margin-block: 8px; }
.source-controls h4, .source-controls h5 { margin: 0; }
.source-controls h4 { font-size: 14px; }
.source-controls label { font-size: 12px; }
.source-controls select { flex: 1 1 240px; min-width: 0; max-width: 100%; }
.source-detail button, .source-detail select { font: inherit; padding: 4px 8px; }
.source-columns { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 10px; }
.source-support { display: grid; min-width: 0; gap: 10px; }
.source-panel { min-width: 0; margin: 0; padding: 8px 10px; border: 1px solid #808080; background: #fff; }
.source-panel-heading { margin: 0 0 6px; padding-bottom: 6px; border-bottom: 1px solid #c4c4c4; font-size: 13px; font-weight: bold; text-wrap: balance; }
details.source-panel:not([open]) > summary { margin-bottom: 0; padding-bottom: 0; border-bottom: 0; }
.source-scroll { max-block-size: min(42dvh, 26rem); overflow: auto; padding: 2px 4px; scrollbar-gutter: stable; }
.source-input-scroll, .source-relations .source-scroll { max-block-size: min(68dvh, 42rem); }
.source-items { list-style: none; padding: 0; margin: 0; }
.source-items > li, .source-scroll > article { padding: 6px 0; border-bottom: 1px solid #d0d0d0; }
.source-items > li:last-child, .source-scroll > article:last-of-type { border-bottom: 0; }
.source-item-heading h6 { display: inline; font: inherit; font-weight: bold; margin: 0; }
.source-item-heading .source-meta { display: inline; margin-inline-start: 8px; }
.source-meta { font-size: 12px; color: #454545; font-variant-numeric: tabular-nums; }
.source-detail section, .source-detail p, .source-detail article, .source-item-heading { overflow-wrap: anywhere; }
.source-detail :is(button, select, summary, h6, .source-scroll, .source-relations):focus-visible { outline: 2px solid #082b78; outline-offset: 2px; }
@container qq-source (min-width: 760px) {
  .source-columns { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
}
</style>
