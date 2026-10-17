<script setup lang="ts">
import { computed } from 'vue'
import { usePluginPage } from './pluginPage'
const props = defineProps<{ id: string }>()
const { state, refresh } = usePluginPage(props.id)
const module = computed(() => state.module)
</script>
<template>
  <main class="manager plugin-page-shell">
    <header>
      <strong>cheryNyxus · {{ module?.descriptor.title || '插件页面' }}</strong
      ><a class="button-link" href="/?tab=plugins">返回插件管理</a>
    </header>
    <p v-if="state.error" role="alert" class="error">{{ state.error }}</p>
    <details class="plugin-resource-details">
      <summary>连接与资源详情</summary>
      <button @click="refresh">刷新连接与资源状态</button>
      <p v-if="module">
      包版本：{{ module.pluginVersion }} · 业务状态：{{ module.businessState }} · Backend资源：{{
        module.descriptor.resourceVersion
      }}
      · Manager接口：{{ module.manager.apiVersion }} · Manager读取资源：{{
        module.manager.resourceVersion || '未读取'
      }}
      · {{ module.manager.state }}
      </p>
    </details>
    <fieldset :disabled="!state.available" style="border: 0; padding: 0; min-width: 0">
      <slot :available="state.available" />
    </fieldset>
  </main>
</template>
<style scoped>
.plugin-page-shell { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
.plugin-resource-details { flex: none; max-height: 30dvh; overflow: auto; padding: 0 8px; }
.plugin-page-shell > fieldset { flex: 1; min-height: 0; margin: 0; overflow: auto; }
</style>
