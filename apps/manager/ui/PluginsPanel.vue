<script setup lang="ts">
import { usePlugins } from './usePlugins'
import { onMounted, ref, watch } from 'vue'
import PluginWindow from './PluginWindow.vue'
const props = defineProps<{ controller: ReturnType<typeof usePlugins> }>()
const { state, ready, read, mutate, config } = props.controller
const opened = ref('')
const pluginWindow = ref<InstanceType<typeof PluginWindow>>()
const stateLabels: Record<string, string> = { inactive: '未启动', starting: '启动中', active: '运行中', stopping: '停止中', stopped: '已停止', failed: '运行失败', unknown: '状态未知' }
const applyLabels: Record<string, string> = { applied: '已应用', pending: '待应用', failed: '应用失败', restart_required: '需重启' }
function pluginName(id: string) {
  return state.modules.filter(item => item.pluginId === id).map(item => item.descriptor.title).join(' / ') || id
}
watch(
  () => state.list,
  (list) => {
    if (list && !list.plugins.some((item) => item.id === opened.value)) {
      opened.value = ''
      config.id = ''
      config.text = ''
      config.dirty = false
    }
  },
)
function open(id: string) {
  if (opened.value === id) return
  if (opened.value && pluginWindow.value && !pluginWindow.value.confirmDiscard()) return
  config.id = ''
  config.text = ''
  config.revision = null
  config.dirty = false
  opened.value = id
}
const capabilities = [
  'tools',
  'hooks',
  'rpc.business',
  'rpc.management',
  'ingress',
  'manager.ui',
  'channel.identity',
] as const
const capabilityLabels: Record<string, string> = { tools: '提供工具', hooks: '参与请求处理', 'rpc.business': '业务接口', 'rpc.management': '管理接口', ingress: '接收消息', 'manager.ui': '提供管理页面', 'channel.identity': '渠道身份' }
function uninstall(id: string) {
  if (window.confirm('卸载将移除专用页面，保留配置与长期数据。确认继续？'))
    void mutate('uninstall', id)
}
onMounted(() => {
  if (!state.list) void read()
})
</script>
<template>
  <section class="panel">
    <div class="section-heading">
      <h1>插件管理</h1>
      <button :disabled="state.reading || state.writing" @click="read">重新读取</button>
    </div>
    <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
    <p v-if="state.message" role="status">{{ state.message }}</p>
    <p v-if="state.uncertain" class="warning">操作结果尚未确认，先重新读取，不要重复提交。</p>
    <details class="package-install panel">
      <summary>安装 / 更新构建包</summary>
      <p class="muted">
        由管理员预置到服务端安装来源目录；不下载URL、不上传文件。未配置来源目录时操作不可用。
      </p>
      <div class="grid">
        <label>来源目录内相对路径<input v-model="state.packagePath" autocomplete="off" /></label>
        <label>完整包 SHA-256<input v-model="state.digest" autocomplete="off" spellcheck="false" /></label>
      </div>
      <fieldset>
        <legend>明确授予的能力</legend>
        <div class="plugin-grants"><label v-for="capability in capabilities" :key="capability"
          ><input v-model="state.grants" type="checkbox" :value="capability" />{{
            capabilityLabels[capability]
          }}</label
        ></div>
      </fieldset>
      <div v-if="state.grants.includes('channel.identity')" class="grid">
        <label>身份渠道<input v-model="state.channel" /></label>
        <label>渠道凭据类型<input v-model="state.credentialKind" /></label>
      </div>
      <button
        :disabled="!ready || !state.packagePath || !/^[a-f0-9]{64}$/.test(state.digest)"
        @click="mutate('install')"
      >
        安装
      </button>
      <button
        :disabled="!ready || !state.packagePath || !/^[a-f0-9]{64}$/.test(state.digest)"
        @click="mutate('upgrade')"
      >
        更新包（需重启）
      </button>
    </details>
    <div class="section-heading"><h2>已安装插件</h2><span v-if="state.list">{{ state.list.plugins.length }} 个</span></div>
    <p v-if="state.reading && !state.list">正在读取插件…</p>
    <p v-if="state.list && !state.list.plugins.length">尚未安装插件。登录与连接功能仍可使用。</p>
    <article v-for="plugin in state.list?.plugins" :key="plugin.id" class="panel plugin-card">
      <div class="section-heading">
        <div><h3>{{ pluginName(plugin.id) }}</h3><code class="muted">{{ plugin.id }}</code></div>
        <div class="plugin-badges"><span>{{ stateLabels[plugin.state] || plugin.state }}</span><span>{{ plugin.enabled ? '业务已启用' : '业务已停用' }}</span></div>
      </div>
      <dl class="plugin-facts">
        <div><dt>已安装版本</dt><dd>{{ plugin.savedVersion || '无' }}</dd></div>
        <div><dt>运行版本</dt><dd>{{ plugin.activeVersion || '尚未运行' }}</dd></div>
        <div><dt>配置版本</dt><dd>保存 {{ plugin.savedRevision ?? '未知' }} / 应用 {{ plugin.appliedRevision ?? '未知' }}</dd></div>
        <div><dt>配置状态</dt><dd>{{ applyLabels[plugin.apply] || plugin.apply }}</dd></div>
      </dl>
      <p v-if="plugin.requiresRestart" class="notice">新代码需重启 Backend 后生效；本页不会自动重启。</p>
      <p v-if="plugin.reason" class="error">原因：{{ plugin.reason }}</p>
      <div class="plugin-card-actions">
        <button @click="open(plugin.id)">打开设置</button>
        <button :disabled="!ready || plugin.enabled" @click="mutate('enable', plugin.id)">启用业务</button>
        <button :disabled="!ready || !plugin.enabled" @click="mutate('disable', plugin.id)">停用业务</button>
        <button :disabled="!ready || plugin.enabled || plugin.state === 'failed'" @click="uninstall(plugin.id)">卸载（保留数据）</button>
      </div>
      <details>
        <summary>依赖与权限详情</summary>
        <dl class="plugin-facts">
          <div><dt>宿主接口版本</dt><dd>{{ plugin.apiVersion }}</dd></div>
          <div><dt>已授予能力</dt><dd>{{ plugin.grantedCapabilities.map(item => capabilityLabels[item] || item).join('、') || '无' }}</dd></div>
        </dl>
        <h4>依赖插件</h4>
        <ul v-if="plugin.dependencies.length"><li v-for="dependency in plugin.dependencies" :key="dependency.id"><code>{{ dependency.id }}</code> · {{ dependency.version }}</li></ul>
        <p v-else>无依赖插件。</p>
      </details>
    </article>
    <div v-if="opened" class="plugin-desktop">
      <PluginWindow ref="pluginWindow" :key="opened" :id="opened" :controller="controller" @close="opened = ''" />
    </div>
  </section>
</template>
