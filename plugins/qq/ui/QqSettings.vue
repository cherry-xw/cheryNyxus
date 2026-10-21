<script setup lang="ts">
import { ref, watch } from 'vue'
import Dropdown from '../../../packages/manager-ui/src/Dropdown.vue'
import type { useQq } from './useQq'
const props = defineProps<{ controller: ReturnType<typeof useQq> }>()
const { state, targets, catalog, add, remove, voices, summary } = props.controller
const category = ref('targets')
const groups = ref(''), users = ref('')
const categories = [ ['targets', '目标与预设'], ['interaction', 'QQ 互动与语音'], ['messages', '消息处理与等待'], ['memory', '记忆与摘要'], ['worker', '技能执行与下载'] ]
type NumberField = { key: string; label: string; min: number; max: number; step?: number }
const numbers: Record<string, NumberField[]> = {
  interaction: [
    { key: 'pokeCooldownMs', label: '戳一戳冷却（毫秒）', min: 10000, max: 3600000 },
    { key: 'voiceMaxChars', label: '语音字数上限', min: 10, max: 200 },
  ],
  messages: [
    { key: 'waitIntervalSeconds', label: '等待反馈间隔（秒，默认 180，即 3 分钟）', min: 10, max: 3600 },
    { key: 'messageMergeMs', label: '连续消息合并等待（毫秒）', min: 0, max: 10000 },
    { key: 'backgroundMaxChars', label: '背景文字上限', min: 1000, max: 100000 },
    { key: 'backgroundMaxAgeMs', label: '背景有效期（毫秒）', min: 1000, max: 604800000 },
    { key: 'continuationTtlMs', label: '活跃讨论超时（毫秒）', min: 1000, max: 86400000 },
    { key: 'maxMessageChars', label: '回复分片字数', min: 100, max: 4000 },
    { key: 'queueLimit', label: '每目标队列上限', min: 1, max: 100 },
    { key: 'historyLimit', label: '历史保留上限', min: 1, max: 1000 },
  ],
  memory: [
    { key: 'memoryMaxEntries', label: '记忆条数上限', min: 10, max: 100 },
    { key: 'memoryMaxChars', label: '每条记忆字数', min: 40, max: 300 },
    { key: 'memoryConsolidateRatio', label: '记忆整理触发比例', min: 0.5, max: 0.95, step: 0.05 },
    { key: 'memoryTargetRatio', label: '记忆整理目标比例', min: 0.2, max: 0.8, step: 0.05 },
    { key: 'memoryContextChars', label: '记忆注入字数预算', min: 500, max: 30000 },
  ],
  worker: [
    { key: 'workerCpuCores', label: '执行容器 CPU 核数上限', min: 0.5, max: 8, step: 0.5 },
    { key: 'workerMemoryMb', label: '执行容器内存上限（MB）', min: 256, max: 8192, step: 128 },
    { key: 'workerPidsLimit', label: '执行容器进程数上限', min: 32, max: 1024 },
    { key: 'workerMaxDownloadMb', label: '单次视频下载上限（MB，1024 MB = 1 GiB）', min: 50, max: 1024 },
    { key: 'workerBubbleVideoMaxMb', label: '视频气泡上限（MB，超出后作为文件发送）', min: 20, max: 500 },
    { key: 'workerProgressIntervalMinutes', label: '下载进度通报间隔（分钟，默认 10）', min: 1, max: 1440 },
    { key: 'workerThreadCount', label: '视频下载与转换线程数', min: 1, max: 16 },
  ],
}
function addTargets(kind: 'groups' | 'users') {
  if (add(kind, kind === 'groups' ? groups.value : users.value)) {
    if (kind === 'groups') groups.value = ''
    else users.value = ''
  }
}
watch(() => [state.selected, state.config?.bindings[state.selected]], () => void summary(state.config?.bindings[state.selected] || ''))
watch(() => state.voiceGroup, () => { void voices() })
watch(() => state.config?.groups.join(','), () => {
  if (!state.config?.groups.includes(state.voiceGroup)) { state.voiceGroup = ''; void voices() }
})
</script>

<template>
  <div class="qq-settings">
    <nav aria-label="QQ 设置分类" class="qq-categories">
      <button v-for="item in categories" :key="item[0]" type="button" :aria-pressed="category === item[0]" @click="category = item[0]">{{ item[1] }}</button>
    </nav>
    <p v-if="state.reading" role="status">正在读取配置…</p>
    <p v-if="!state.config && !state.reading" class="notice">配置尚不可用，请恢复连接后重新读取。不会将读取失败当作空白名单。</p>
    <template v-if="state.config">
      <fieldset class="qq-setting-fields" :disabled="!state.ready || state.reading || state.saving || state.uncertain">
        <legend>{{ categories.find(item => item[0] === category)?.[1] }}</legend>
        <section v-show="category === 'targets'">
          <div class="section-heading"><h3>允许的目标与预设绑定</h3><button type="button" @click="catalog">刷新预设目录</button></div>
          <p v-if="state.catalogError" class="error" role="alert">预设目录读取失败：{{ state.catalogError }}</p>
          <div class="grid">
            <label>允许的群号<textarea v-model="groups" rows="2" placeholder="多个号码用空格或逗号分隔" /><button type="button" @click="addTargets('groups')">添加群</button></label>
            <label>允许私聊的 QQ 号<textarea v-model="users" rows="2" placeholder="多个号码用空格或逗号分隔" /><button type="button" @click="addTargets('users')">添加私聊</button></label>
            <label>当前目标<Dropdown v-model="state.selected" label="当前目标"><option value="">请选择目标</option><option v-for="target in targets" :key="target" :value="target">{{ target.startsWith('group:') ? '群 ' + target.slice(6) : '私聊 ' + target.slice(13) }}</option></Dropdown></label>
            <label>已有预设<Dropdown v-if="state.selected" v-model="state.config.bindings[state.selected]" label="已有预设" :disabled="!state.catalog"><option value="">未绑定</option><option v-for="name in state.catalog?.presets || []" :key="name" :value="name">{{ name }}</option></Dropdown><span v-else>先选择目标</span></label>
          </div>
          <p class="muted">空名单不允许任何目标；未绑定预设也不会处理消息。群内需要 @ 机器人，私聊不需要。</p>
          <button v-if="state.selected" type="button" @click="remove(state.selected)">移除此目标及绑定（保存后生效）</button>
          <p v-if="state.summary">{{ state.summary }}</p><p v-if="state.summaryError" class="error">{{ state.summaryError }}</p>
          <dl class="qq-targets"><div v-for="target in targets" :key="target"><dt>{{ target.startsWith('group:') ? '群 ' + target.slice(6) : '私聊 ' + target.slice(13) }}</dt><dd>{{ state.config.bindings[target] || '未绑定，不能聊天' }}</dd></div></dl>
          <p v-if="!targets.length">名单为空。</p>
        </section>
        <section v-show="category === 'interaction'">
          <h3>QQ 原生互动</h3>
          <div class="grid"><label><input v-model="state.config.reactionEnabled" type="checkbox" />启用表情回复</label><label><input v-model="state.config.pokeEnabled" type="checkbox" />启用戳一戳</label></div>
          <h3>语音</h3>
          <div class="grid">
            <label>语音使用方式<Dropdown v-model="state.config.voiceMode" label="语音使用方式"><option value="off">关闭</option><option value="requested">仅用户明确要求时使用</option><option value="auto">AI 可以自主选择</option></Dropdown></label>
            <label>声音目录来源群<Dropdown v-model="state.voiceGroup" label="声音目录来源群"><option value="">请选择允许的群</option><option v-for="id in state.config.groups" :key="id" :value="id">{{ id }}</option></Dropdown></label>
            <label class="wide">固定声音<Dropdown v-model="state.config.voiceDefaultCharacter" label="固定声音" :disabled="!state.voiceGroup || state.voicesLoading || !!state.voicesError"><option value="">未设置</option><option v-if="state.config.voiceDefaultCharacter && !state.voices.some(v => v.id === state.config.voiceDefaultCharacter)" :value="state.config.voiceDefaultCharacter" disabled>当前声音未验证：{{ state.config.voiceDefaultCharacter }}</option><option v-for="voice in state.voices" :key="voice.id" :value="voice.id">{{ voice.name }}</option></Dropdown><button type="button" :disabled="!state.voiceGroup || state.voicesLoading" @click="voices">{{ state.voicesLoading ? '读取中…' : '刷新声音目录' }}</button><span v-if="state.voicesError" class="error" role="alert">{{ state.voicesError }}</span><span v-else-if="state.voiceGroup && !state.voicesLoading && !state.voices.length">该群没有可用声音</span></label>
          </div>
        </section>
        <section v-show="category === 'messages'">
          <h3>消息处理与等待反馈</h3>
          <h3>QQ 原图存储</h3>
          <div class="grid">
            <label>单张原图上限（字节）<input v-model.number="state.config.imageStorage.singleBytes" type="number" min="1" max="20971520" /></label>
            <label>全部目标总额度（字节）<input v-model.number="state.config.imageStorage.totalBytes" type="number" min="1" max="2147483648" /></label>
            <label>每个目标额度（字节）<input v-model.number="state.config.imageStorage.perTargetBytes" type="number" min="1" max="268435456" /></label>
          </div>
          <p class="muted">默认单张 20 MiB、全部 2 GiB、每目标 256 MiB。满额停止新采集，不自动删除；移除关联后停止采集和新读取，保留原件。只采集已允许且预设有效的目标，不补收旧图。模型图片输入大小单独管理。</p>
          <p class="muted">运行中的请求保留原设置。模型、工具组和预设内容在对应设置插件中管理。</p>
        </section>
        <section v-show="category === 'memory'"><h3>记忆与讨论摘要</h3></section>
        <section v-show="category === 'worker'"><h3>技能执行与视频下载</h3><div class="grid"><label><input v-model="state.config.workerEnabled" type="checkbox" />启用通用执行容器</label><label><input v-model="state.config.workerProgressEnabled" type="checkbox" />定时通报下载进度</label></div><p class="muted">资源限制作用于下一条执行命令，不改变正在运行的命令。</p></section>
        <div v-if="numbers[category]" :key="category" class="grid qq-number-fields">
          <label v-for="field in numbers[category]" :key="field.key">{{ field.label }}<input v-model.number="state.config[field.key]" type="number" :min="field.min" :max="field.max" :step="field.step || 1" /></label>
        </div>
        <section v-show="category === 'messages'">
          <div class="grid">
            <label>等待文案顺序<Dropdown v-model="state.config.waitMessageMode" label="等待文案顺序"><option value="cycle">循环</option><option value="random">随机</option></Dropdown></label>
            <label class="wide">等待文案（每行一条）<textarea :value="state.config.waitMessages.join('\n')" rows="4" @input="state.config.waitMessages = ($event.target as HTMLTextAreaElement).value.split('\n')" /></label>
            <label class="wide"><input v-model="state.config.toolIconsEnabled" type="checkbox" />发送实际调用工具图标及同周期已有正文</label>
          </div>
          <details><summary>工具图标映射</summary><div class="grid"><label v-for="tool in state.catalog?.tools || []" :key="tool.name">{{ tool.label || tool.name }}<input :value="state.config.toolIcons[tool.name] || ''" @input="($event.target as HTMLInputElement).value ? state.config.toolIcons[tool.name] = ($event.target as HTMLInputElement).value : delete state.config.toolIcons[tool.name]" /></label></div></details>
        </section>
        <div v-show="category === 'memory'" class="grid"><label class="wide">讨论摘要提示词<textarea v-model="state.config.summaryPrompt" rows="6" /></label></div>
      </fieldset>
    </template>
  </div>
</template>

<style scoped>
.qq-setting-fields { margin-top: 12px; padding: 12px; border: 1px solid #808080; }
.qq-categories { margin: 0; }
.qq-number-fields { margin: 12px 0; }
.qq-targets > div { display: grid; grid-template-columns: minmax(100px, 1fr) 2fr; gap: 12px; padding: 8px; border-bottom: 1px solid #808080; overflow-wrap: anywhere; }
.qq-targets dd { margin: 0; }
</style>
