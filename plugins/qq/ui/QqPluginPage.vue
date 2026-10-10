<script setup lang="ts">
import PluginPageShell from '../../../packages/manager-ui/src/PluginPageShell.vue'
import QqPanel from './QqPanel.vue'
import { ref, onMounted } from 'vue'
import { managerRequest } from '../../../packages/manager-ui/src/api'
const token = ref(''),
  visible = ref(false),
  error = ref(''),
  writing = ref(false)
async function read() {
  try {
    token.value = (await managerRequest<{ token: string }>('/api/connections/qq/credential')).token
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : '凭据读取失败'
  }
}
async function rotate() {
  if (!window.confirm('旧 NapCat 连接会失效，需要更新凭据并重启 Backend。确认继续？')) return
  writing.value = true
  try {
    await managerRequest('/api/connections/qq/credential/rotate', { method: 'POST', body: '{}' })
    await read()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '结果未确认，请重新读取'
  } finally {
    writing.value = false
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(token.value)
  } catch {
    error.value = '复制失败，请手动复制'
  }
}
onMounted(() => void read())
</script>
<template>
  <PluginPageShell id="qq"
    ><QqPanel
      ><template #token
        ><section class="panel">
          <h2>QQ 连接凭据</h2>
          <p v-if="error" role="alert" class="error">{{ error }}</p>
          <div class="token-row">
            <input
              :value="visible ? token : token ? '已配置' : '未读取'"
              readonly
              aria-label="QQ 连接凭据"
            /><button @click="visible = !visible">{{ visible ? '隐藏' : '查看' }}</button
            ><button :disabled="!token" @click="copy">复制</button
            ><button @click="read">重新读取</button
            ><button :disabled="writing" @click="rotate">重新生成</button>
          </div>
        </section></template
      ></QqPanel
    ></PluginPageShell
  >
</template>
