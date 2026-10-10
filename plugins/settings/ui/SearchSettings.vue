<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { managerRequest } from '../../../packages/manager-ui/src/api'
const endpoint = '/api/modules/capabilities/search-settings'
const labels: Record<string, string> = { anysearch: 'AnySearch', parallel: 'Parallel', exa: 'Exa', browser: '浏览器搜索（Bing / 百度）' }
const settings = ref({ providers: ['anysearch', 'parallel', 'exa', 'browser'], proxyEnabled: false, proxyUrl: '' })
const revision = ref(''); const busy = ref(false); const message = ref('')
async function load() {
  busy.value = true
  try { const r = await managerRequest<{data: {settings: typeof settings.value; revision: string}}>(endpoint); settings.value = r.data.settings; revision.value = r.data.revision }
  catch (e) { message.value = e instanceof Error ? e.message : '读取失败' }
  finally { busy.value = false }
}
async function save() {
  busy.value = true; message.value = ''
  try {
    await managerRequest(endpoint, {method: 'PUT', body: JSON.stringify({settings: settings.value, expectedRevision: revision.value})})
    const r = await managerRequest<{data: {settings: typeof settings.value; revision: string}}>(endpoint)
    if (JSON.stringify(r.data.settings) !== JSON.stringify(settings.value)) throw new Error('保存后设置发生变化，请重新读取')
    settings.value = r.data.settings; revision.value = r.data.revision; message.value = '已保存，下一次搜索生效'
  } catch (e) { message.value = e instanceof Error ? e.message : '保存未确认，请重新读取核对' }
  finally { busy.value = false }
}
function move(index: number, offset: number) {
  const a = settings.value.providers; const next = index + offset
  if (next >= 0 && next < a.length) [a[index], a[next]] = [a[next], a[index]]
}
onMounted(load)
</script>
<template>
  <details class="search-settings">
    <summary>网络搜索设置</summary>
    <p>按下面顺序自动尝试；服务失败或没有有效结果时换下一种。浏览器搜索用于最后兜底，不使用 DuckDuckGo。</p>
    <fieldset :disabled="busy || !revision">
      <ol><li v-for="(provider, index) in settings.providers" :key="provider">{{ labels[provider] }} <button type="button" :disabled="index === 0" @click="move(index, -1)">上移</button> <button type="button" :disabled="index === settings.providers.length - 1" @click="move(index, 1)">下移</button></li></ol>
      <label><input v-model="settings.proxyEnabled" type="checkbox" />搜索请求使用代理</label>
      <label>代理地址<input v-model="settings.proxyUrl" placeholder="http://10.2.3.6:7890" autocomplete="off" /></label>
      <p>仅影响搜索，不影响模型和其他工具。容器内的 127.0.0.1 不是宿主机；本机代理请填写容器可访问的地址。不支持在地址中填写密码。</p>
      <button type="button" @click="save">保存搜索设置</button>
    </fieldset>
    <button type="button" :disabled="busy" @click="load">重新读取</button>
    <p role="status">{{ message }}</p>
  </details>
</template>
