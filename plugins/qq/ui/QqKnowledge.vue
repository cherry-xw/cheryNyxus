<script setup lang="ts">
import { watch,onUnmounted } from 'vue'
import Dropdown from '../../../packages/manager-ui/src/Dropdown.vue'
import { useQqKnowledge } from './useQqKnowledge'
const props=defineProps<{targets:string[];active:boolean}>()
const emit=defineEmits<{dirty:[value:boolean]}>()
const {state,read,learning,edit,adoption,retry,begin,saveEdit,clear}=useQqKnowledge()
watch(()=>!!state.editing||state.saving||state.uncertain,value=>emit('dirty',value),{immediate:true})
watch(()=>props.active,active=>{if(active){state.target ||= props.targets[0]??'';void read();void learning()}else clear()},{immediate:true})
watch(()=>[state.target,state.scope],()=>{if(props.active){state.editing=null;void read()}})
onUnmounted(clear)
function confirmDelete(id:string){if(window.confirm(state.scope==='public'?'删除所有群共用的这条公共词义？本地独立用法不受影响。':'删除当前目标的这条记忆？原证据不会被自动重新导入。'))void edit({delete:[id]})}
const status=(value:string)=>({pending:'等待学习',running:'学习中',completed:'已完成',failed:'失败',cancelled:'已取消',active:'有效',disputed:'有争议',superseded:'已替代',inactive:'不采用'} as Record<string,string>)[value]??value
</script>
<template>
  <section class="panel qq-view qq-knowledge" :aria-busy="state.loading||state.saving">
    <h2>记忆与学习</h2>
    <div class="controls"><label>目标<Dropdown v-model="state.target" label="记忆目标" :disabled="state.saving||!!state.editing||state.uncertain"><option v-for="target in targets" :key="target" :value="target">{{target}}</option></Dropdown></label>
      <label>范围<Dropdown v-model="state.scope" label="记忆范围" :disabled="state.saving||!!state.editing||state.uncertain"><option value="local">本群／本私聊</option><option value="public">同一机器人公共词义</option></Dropdown></label>
      <button type="button" :disabled="state.loading||state.saving||!state.target" @click="read()">{{state.loading?'读取中…':'刷新记忆'}}</button>
    </div>
    <p v-if="state.error" role="alert" class="error">{{state.error}}</p><p v-if="state.message" role="status">{{state.message}}</p>
    <p v-if="!state.target">请先在设置中保存允许的群或私聊。</p><p v-else-if="!state.loading&&!state.entries.length&&!state.error">当前范围没有记忆。</p>
    <p v-if="state.uncertain">保存结果尚未确认，先刷新核对；原草稿保留。</p>
    <label>本次修改依据<input v-model="state.note" maxlength="1000" :disabled="state.saving" placeholder="纠正或删除的原因" /></label>
    <p>修改以管理员说明为来源，不伪造聊天或网页。删除防止原证据再次导入；本群拒用公共词义后须明确恢复。</p>
    <ul class="entries"><li v-for="entry in state.entries" :key="entry.id">
      <h3>{{entry.term}} <small>{{status(entry.status)}} · 版本 {{entry.revision}}<span v-if="state.rejected.includes(entry.id)"> · 本目标不采用</span></small></h3>
      <p class="body">{{entry.meaning}}</p><p v-if="entry.usage">用法：{{entry.usage}}</p><p v-if="entry.caveat">注意：{{entry.caveat}}</p>
      <details><summary>来源与适用范围</summary><p>{{entry.aliases.join('、')||'无别名'}} · {{state.scope==='local'?'仅当前目标':'同一机器人QQ范围'}}</p>
        <ul><li v-for="(source,index) in entry.sources" :key="index"><template v-if="source.kind==='web'">网页 {{source.url}} · {{source.observedAt}}<span v-if="source.truncated"> · 已截断</span><p>{{source.excerpt}}</p></template>
          <template v-else-if="source.kind==='admin'">管理员说明：{{source.note}}</template><template v-else>消息 {{source.recordId}} · {{source.actorId}}<p>{{source.excerpt}}</p></template></li></ul>
      </details>
      <div class="controls"><button type="button" :disabled="state.saving||state.uncertain" @click="begin(entry)">纠正</button>
        <button type="button" :disabled="state.saving||state.uncertain||!state.note.trim()" @click="confirmDelete(entry.id)">删除</button>
        <template v-if="state.scope==='public'"><button type="button" :disabled="state.saving||state.uncertain||!state.note.trim()" @click="adoption(entry.id,false)">本目标不采用</button><button type="button" :disabled="state.saving||state.uncertain||!state.note.trim()" @click="adoption(entry.id,true)">恢复本目标采用</button></template>
      </div>
    </li></ul>
    <button v-if="state.nextCursor" type="button" :disabled="state.loading||state.saving" @click="read(true)">继续读取</button>
    <form v-if="state.editing" @submit.prevent="saveEdit"><h3>纠正：{{state.editing.term}}</h3>
      <label>含义<textarea v-model="state.editing.meaning" required maxlength="1000" :disabled="state.saving" /></label>
      <label>用法<textarea v-model="state.editing.usage" maxlength="1000" :disabled="state.saving" /></label>
      <label>注意<textarea v-model="state.editing.caveat" maxlength="500" :disabled="state.saving" /></label>
      <label>状态<Dropdown v-model="state.editing.status" label="记忆状态" :disabled="state.saving"><option v-if="state.scope==='local'" value="active">有效</option><option value="disputed">有争议</option><option value="inactive">不采用</option><option value="superseded">已替代</option></Dropdown></label>
      <button type="submit" :disabled="state.saving||state.uncertain||!state.note.trim()">{{state.saving?'保存中…':'保存纠正'}}</button><button type="button" :disabled="state.saving" @click="state.editing=null">取消</button>
    </form>
    <section><div class="controls"><h3>学习状态与额度</h3><button type="button" @click="learning">刷新学习状态</button></div>
      <template v-if="state.learning"><p>本小时 {{state.learning.usedCalls}} / {{state.learning.limit}} 次 · 待处理 {{state.learning.pending}}<span v-if="state.learning.reason"> · {{state.learning.reason}}</span></p>
        <ul><li v-for="task in state.learning.tasks" :key="task.operationId">{{task.target}} · {{status(task.state)}} · {{task.phase==='local'?'本地记忆':'公共词义'}}<span v-if="task.reason"> · {{task.reason}}</span><span v-if="task.nextAt"> · 下次 {{new Date(task.nextAt).toLocaleString()}}</span><button v-if="task.state==='failed'" type="button" @click="retry(task.operationId)">重试此项</button></li></ul>
      </template>
    </section>
  </section>
</template>
<style scoped>
.qq-knowledge{overflow:auto;min-height:0}.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.entries{list-style:none;padding:0}.entries>li{border:1px solid #808080;padding:12px;margin-block:12px}.body{white-space:pre-wrap}p,li{overflow-wrap:anywhere}label{display:flex;flex-direction:column;gap:4px;margin-block:8px}textarea{min-height:80px;width:100%;box-sizing:border-box}small{font-weight:normal}button:focus-visible{outline:2px solid #000080;outline-offset:2px}
</style>
