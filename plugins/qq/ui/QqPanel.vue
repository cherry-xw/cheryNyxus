<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useQq } from './useQq'
import QqSettings from './QqSettings.vue'
import QqRecords from './QqRecords.vue'
import QqDiagnostics from './QqDiagnostics.vue'
import { applyLabel } from './qqPresentation'
const controller = useQq()
const { state, dirty, read, save, load } = controller
const view = ref('settings')
const views = [['settings', '设置'], ['queue', '队列'], ['history', '历史'], ['diagnostics', '连接与诊断']]
const emit = defineEmits<{ dirty: [value: boolean] }>()
watch(() => dirty.value || state.saving, value => {
  emit('dirty', value)
  if (window.parent !== window) window.parent.postMessage({ type: 'cheryNyxus:plugin-dirty', dirty: value }, window.location.origin)
}, { immediate: true })
function discard() {
  if (!dirty.value || window.confirm('重新读取会丢弃未保存草稿，继续吗？')) void read(true)
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value || state.saving) { event.preventDefault(); event.returnValue = '' }
}
onMounted(() => { void load(); window.addEventListener('beforeunload', beforeUnload) })
onUnmounted(() => window.removeEventListener('beforeunload', beforeUnload))
</script>

<template>
  <div class="qq-workspace">
    <div class="qq-toolbar">
      <div class="section-heading">
        <nav aria-label="QQ 插件页面"><button v-for="item in views" :key="item[0]" type="button" :aria-pressed="view === item[0]" @click="view = item[0]">{{ item[1] }}</button></nav>
        <div class="qq-save-actions"><button type="button" :disabled="state.reading || state.saving" @click="discard">重新读取配置</button><button type="button" :disabled="!dirty || !state.ready || state.saving || state.reading || state.uncertain" @click="save">{{ state.saving ? '保存并核对中…' : '保存并回读确认' }}</button></div>
      </div>
      <p role="status">{{ dirty ? '有未保存草稿' : state.config ? '配置已回读' : '尚未读取配置' }} · {{ state.message }}<span v-if="state.apply"> · {{ applyLabel(state.apply.state) }}</span></p>
      <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
      <p v-if="state.uncertain" class="warning">写入结果未知或版本冲突，请重新读取核对；不会自动重复保存。</p>
      <p v-else-if="dirty && !state.ready" class="warning">当前配置连接不可用，恢复连接并重新读取后才能保存。</p>
    </div>
    <section v-show="view === 'settings'" class="panel qq-view"><h2>QQ 设置</h2><QqSettings :controller="controller" /></section>
    <QqRecords v-for="kind in ['queue', 'history'] as const" v-show="view === kind" :key="kind" :kind="kind" :active="view === kind" :controller="controller" />
    <div v-if="view === 'diagnostics'" class="qq-view"><QqDiagnostics :controller="controller"><template #token><slot name="token" /></template></QqDiagnostics></div>
  </div>
</template>

<style scoped>
.qq-workspace { min-width: 0; height: 100%; display: flex; flex-direction: column; }
.qq-toolbar { flex: none; background: #d4d0c8; border-bottom: 2px solid #808080; padding: 6px 10px; }
.qq-view { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
.qq-toolbar nav { margin: 0; }
.qq-toolbar p { margin: 6px 4px; }
.qq-save-actions { display: flex; flex-wrap: wrap; gap: 4px; }
</style>
