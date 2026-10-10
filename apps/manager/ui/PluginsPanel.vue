<script setup lang="ts">
import { usePlugins } from './usePlugins'
import { onMounted, ref, watch } from 'vue'
import PluginWindow from './PluginWindow.vue'
const props = defineProps<{ controller: ReturnType<typeof usePlugins> }>()
const { state, ready, read, mutate, config } = props.controller
const opened = ref('')
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
  if (config.dirty && !window.confirm('切换插件会丢弃未保存的包配置，确认继续？')) return
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
    <p role="status">{{ state.message }}</p>
    <p v-if="state.uncertain" class="warning">操作结果尚未确认，先重新读取，不要重复提交。</p>
    <p v-if="state.list && !state.list.plugins.length">尚未安装插件。登录与连接功能仍可使用。</p>
    <article v-for="plugin in state.list?.plugins" :key="plugin.id" class="panel">
      <h2>{{ plugin.id }}</h2>
      <p>
        已安装：{{ plugin.installed ? '是' : '否' }} · 已启用：{{ plugin.enabled ? '是' : '否' }} ·
        业务状态：{{ plugin.state }}
      </p>
      <p>
        保存包版本：{{ plugin.savedVersion || '无' }} · 活动包版本：{{
          plugin.activeVersion || '无'
        }}
        · 宿主接口：{{ plugin.apiVersion }}
      </p>
      <p>
        配置保存版本：{{ plugin.savedRevision ?? '未知' }} · 应用版本：{{
          plugin.appliedRevision ?? '未知'
        }}
        · 应用状态：{{ plugin.apply }}
      </p>
      <p v-if="plugin.requiresRestart" class="warning">
        代码或启用状态需重启 Backend 后生效，本页不会自动重启。
      </p>
      <p v-if="plugin.reason" class="error">原因：{{ plugin.reason }}</p>
      <p>
        依赖：{{
          plugin.dependencies.map((item) => `${item.id}@${item.version}`).join('、') || '无'
        }}
      </p>
      <p>已授予能力：{{ plugin.grantedCapabilities.join('、') || '无' }}</p>
      <button @click="open(plugin.id)">打开</button>
      <button :disabled="!ready || plugin.enabled" @click="mutate('enable', plugin.id)">
        启用业务
      </button>
      <button :disabled="!ready || !plugin.enabled" @click="mutate('disable', plugin.id)">
        停用业务（保留管理）
      </button>
      <button
        :disabled="!ready || plugin.enabled || plugin.state === 'failed'"
        @click="uninstall(plugin.id)"
      >
        卸载（保留数据）
      </button>
    </article>
    <div v-if="opened" class="plugin-desktop">
      <PluginWindow :key="opened" :id="opened" :controller="controller" @close="opened = ''" />
    </div>
    <details>
      <summary>安装或更新预构建包</summary>
      <p class="muted">
        由管理员预置到服务端安装来源目录；不下载URL、不上传文件。未配置来源目录时操作不可用。
      </p>
      <label>来源目录内相对路径<input v-model="state.packagePath" autocomplete="off" /></label>
      <label>完整包 SHA-256<input v-model="state.digest" autocomplete="off" /></label>
      <fieldset>
        <legend>明确授予的能力</legend>
        <label v-for="capability in capabilities" :key="capability"
          ><input v-model="state.grants" type="checkbox" :value="capability" />{{
            capability
          }}</label
        >
      </fieldset>
      <label>身份渠道（仅授予渠道身份时）<input v-model="state.channel" /></label
      ><label>渠道凭据类型<input v-model="state.credentialKind" /></label>
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
  </section>
</template>
