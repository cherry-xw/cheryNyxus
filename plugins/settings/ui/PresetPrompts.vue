<script setup lang="ts">
import { reactive, watch } from 'vue'
import { managerRequest } from '../../../packages/manager-ui/src/api'
const props = defineProps<{ preset: string; disabled?: boolean }>()
const emit = defineEmits<{ saved: [] }>()
const state = reactive({ global: '', role: '', baseRevision: '', contentRevisions: {global: '', role: ''}, sharedPresets: [] as string[], loading: false, error: '', message: '', uncertain: false })
let generation = 0
async function load() {
  const current = ++generation
  state.error = ''; state.message = ''; state.uncertain = true
  if (!props.preset) return
  state.loading = true
  try {
    const result = await managerRequest<any>(`/api/modules/capabilities/prompts?preset=${encodeURIComponent(props.preset)}`)
    if (current !== generation) return
    Object.assign(state, result.data); state.uncertain = false
  } catch (error) { if (current === generation) state.error = error instanceof Error ? error.message : '提示词读取失败' }
  finally { if (current === generation) state.loading = false }
}
async function save(scope: 'global' | 'role') {
  if (scope === 'global' && !window.confirm('修改全局提示词会影响所有预设，确认保存？')) return
  if (scope === 'role' && state.sharedPresets.length > 1 && !window.confirm(`此角色提示词被以下预设共用：${state.sharedPresets.join('、')}。确认保存？`)) return
  state.loading = true; state.error = ''; state.message = ''
  try {
    const result = await managerRequest<any>('/api/modules/capabilities/prompts', { method: 'PUT', body: JSON.stringify({preset: props.preset, scope, content: state[scope], expectedContentRevision: state.contentRevisions[scope], expectedBaseRevision: state.baseRevision}) })
    Object.assign(state, result.data)
    state.message = '已保存并回读。运行中会话保留原快照，需要配置边界更新或重建会话后使用新提示词。'
    emit('saved')
  } catch (error) { state.uncertain = true; state.error = error instanceof Error ? error.message : '保存结果未确认，请重新读取' }
  finally { state.loading = false }
}
watch(() => props.preset, load, { immediate: true })
</script>
<template>
  <section v-if="preset" class="preset-prompts" aria-label="预设提示词">
    <h3>提示词</h3>
    <fieldset :disabled="disabled || state.loading || state.uncertain">
      <label>全局提示词（所有预设共用）<textarea v-model="state.global" rows="10" maxlength="100000" /></label>
      <p>修改此处会影响所有预设，不包含系统自动生成的环境、记忆和工具信息。</p>
      <button type="button" @click="save('global')">保存全局提示词</button>
      <label>当前预设主角色提示词<textarea v-model="state.role" rows="10" maxlength="100000" /></label>
      <p>作为全局提示词的补充。共用此角色或文件的预设：{{ state.sharedPresets.join('、') }}</p>
      <button type="button" @click="save('role')">保存角色提示词</button>
    </fieldset>
    <p v-if="state.loading" role="status">处理中…</p>
    <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
    <p v-if="state.message" role="status">{{ state.message }}</p>
    <button type="button" :disabled="state.loading || disabled" @click="load">重新读取提示词（替换草稿）</button>
  </section>
</template>
<style scoped>
.preset-prompts { width: 100%; }
fieldset { border: 0; margin: 0; padding: 0; }
label { display: flex; flex-direction: column; gap: 8px; margin: 12px 0; }
textarea { width: 100%; box-sizing: border-box; min-height: 180px; resize: vertical; font: inherit; }
p { overflow-wrap: anywhere; }
</style>
