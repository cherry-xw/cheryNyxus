<script setup lang="ts">
import { computed } from 'vue'
import { resolveConversationPolicy } from '../../../packages/protocol/src/qq'
import type { useQq } from './useQq'
const props = defineProps<{ controller: ReturnType<typeof useQq> }>()
const state = props.controller.state
const preview = computed(() => resolveConversationPolicy(state.config, state.selected || 'group:'))
const fields = [ ['mode','参与方式'], ['initiative','参与倾向'], ['style','表达风格'] ] as const
const options = { mode: [['followup','@后续聊'],['proactive','适度主动参与']], initiative: [['quiet','偏安静'],['balanced','适中'],['lively','较活跃']], style: [['concise','简洁直接'],['casual','自然随和'],['playful','轻松调侃']] }
function setOverride(key: string, value: string) {
  const id = state.selected.slice(6), groups = state.config.conversation.groups
  if (value === '') { if (groups[id]) delete groups[id][key] }
  else { groups[id] ??= {}; groups[id][key] = value }
  if (groups[id] && !Object.keys(groups[id]).length) delete groups[id]
}
function toggleCustom(enabled: boolean) {
  const id = state.selected.slice(6), groups = state.config.conversation.groups
  if (enabled) { groups[id] ??= {}; groups[id].customStyle = '' }
  else { if (groups[id]) delete groups[id].customStyle; if (groups[id] && !Object.keys(groups[id]).length) delete groups[id] }
}
</script>
<template>
  <section>
    <h3>默认聊天方式</h3>
    <div class="grid">
      <label v-for="[key, label] in fields" :key="key">{{ label }}<select v-model="state.config.conversation.defaults[key]"><option v-for="[value,text] in options[key]" :key="value" :value="value">{{ text }}</option></select></label>
      <label class="wide">默认表达补充<textarea v-model="state.config.conversation.defaults.customStyle" maxlength="2000" rows="3" /></label>
      <label>私聊风格<select v-model="state.config.conversation.privateStyle.style"><option v-for="[value,text] in options.style" :key="value" :value="value">{{ text }}</option></select></label>
      <label class="wide">私聊表达补充<textarea v-model="state.config.conversation.privateStyle.customStyle" maxlength="2000" rows="3" /></label>
    </div>
    <template v-if="state.selected.startsWith('group:')">
      <h3>当前群覆盖</h3>
      <div class="grid">
        <label v-for="[key,label] in fields" :key="key">{{ label }}<select :value="state.config.conversation.groups[state.selected.slice(6)]?.[key] ?? ''" @change="setOverride(key, ($event.target as HTMLSelectElement).value)"><option value="">使用默认</option><option v-for="[value,text] in options[key]" :key="value" :value="value">{{ text }}</option></select></label>
        <label class="wide"><input type="checkbox" :checked="Object.hasOwn(state.config.conversation.groups[state.selected.slice(6)] ?? {}, 'customStyle')" @change="toggleCustom(($event.target as HTMLInputElement).checked)" />单独设置本群表达补充</label>
        <label v-if="Object.hasOwn(state.config.conversation.groups[state.selected.slice(6)] ?? {}, 'customStyle')" class="wide">本群表达补充（空文字表示清空）<textarea v-model="state.config.conversation.groups[state.selected.slice(6)].customStyle" maxlength="2000" rows="3" /></label>
      </div>
      <p>未保存预览：{{ preview.effective.mode === 'proactive' ? '适度主动参与' : '@后续聊' }}；各字段按本群覆盖或默认值生效。</p>
    </template>
    <label class="wide">QQ 补充说明<textarea v-model="state.config.systemPrompt" maxlength="20000" rows="5" /></label>
    <label><input v-model="state.config.linkAutoDownloadEnabled" type="checkbox" />自动处理未 @ 的支持站点视频链接</label>
    <details><summary>主动参与的次数与等待</summary>
      <p>观察后即使不回复也可能产生模型费用。这些上限不包含正常续聊、明确请求和学习费用；无新消息不自行发起聊天。</p>
      <div class="grid"><label v-for="field in [{key:'batchWaitMs',label:'聚合等待（毫秒）',min:0,max:10000},{key:'minCheckIntervalMs',label:'非活跃观察间隔（毫秒）',min:1000,max:3600000},{key:'maxChecksPerHour',label:'每群每小时观察次数',min:1,max:3600},{key:'minReplyIntervalMs',label:'新参与间隔（毫秒）',min:0,max:3600000},{key:'contextReadLimit',label:'判断前补查次数',min:0,max:5}]" :key="field.key">{{ field.label }}<input v-model.number="state.config.conversation.proactive[field.key]" type="number" :min="field.min" :max="field.max" /></label></div>
    </details>
  </section>
</template>
