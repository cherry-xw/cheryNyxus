<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { usePlugins } from './usePlugins'
import { useWindowDrag } from './useWindowDrag'
const props = defineProps<{ id: string; controller: ReturnType<typeof usePlugins> }>()
const emit = defineEmits<{ close: [] }>()
const { state, ready, config, readConfig, saveConfig } = props.controller
const modules = computed(() => state.modules.filter((item) => item.pluginId === props.id))
const selected = ref('')
const loaded = ref<Record<string, boolean>>({})
const failures = ref<Record<string, string>>({})
const { position, start, move, end } = useWindowDrag()
watch(
  modules,
  (items) => {
    if (!items.some((item) => item.descriptor.id === selected.value))
      selected.value = items[0]?.descriptor.id || 'package-config'
  },
  { immediate: true },
)
function close() {
  if (!config.dirty || window.confirm('关闭会丢弃未保存的包配置，确认继续？')) {
    config.id = ''
    config.text = ''
    config.revision = null
    config.dirty = false
    emit('close')
  }
}
</script>
<template>
  <section
    class="plugin-window"
    role="dialog"
    :aria-label="`${id} 设置`"
    :style="{ left: `${position.x}px`, top: `${position.y}px` }"
  >
    <header
      class="plugin-window-title"
      @pointerdown="start"
      @pointermove="move"
      @pointerup="end"
      @pointercancel="end"
      @lostpointercapture="end"
    >
      <strong>{{ id }} 设置</strong
      ><button type="button" aria-label="关闭插件窗口" @click="close">×</button>
    </header>
    <nav aria-label="插件内部设置">
      <button
        v-for="module in modules"
        :key="module.descriptor.id"
        :aria-selected="selected === module.descriptor.id"
        @click="selected = module.descriptor.id"
      >
        {{ module.descriptor.title }}
      </button>
      <button :aria-selected="selected === 'package-config'" @click="selected = 'package-config'">
        包配置
      </button>
    </nav>
    <p v-if="state.error" class="error" role="alert">{{ state.error }}</p>
    <p v-if="state.message" role="status">{{ state.message }}</p>
    <div class="plugin-window-content">
      <section
        v-for="module in modules"
        v-show="selected === module.descriptor.id"
        :key="`${module.descriptor.id}:${module.descriptor.resourceVersion}`"
        class="plugin-page"
      >
        <p class="muted">
          资源版本：{{ module.descriptor.resourceVersion }} · Manager 接口：{{
            module.manager.apiVersion
          }}
          · 页面状态：{{ module.manager.state }} {{ module.manager.reason || '' }}
        </p>
        <template v-if="module.manager.state === 'ready' || module.manager.reason === 'resource_not_loaded'">
          <p v-if="!loaded[module.descriptor.id]">正在加载插件页面…</p>
          <p v-if="failures[module.descriptor.id]" class="error">
            {{ failures[module.descriptor.id] }}
          </p>
          <iframe
            :src="`${module.pagePath}?embedded=1`"
            :title="module.descriptor.title"
            @load="loaded[module.descriptor.id] = true"
            @error="failures[module.descriptor.id] = '页面加载失败，请重新打开。'"
          />
        </template>
        <p v-else class="error">插件页面暂不可用。可读取包配置或重新读取插件目录。</p>
      </section>
      <section v-show="selected === 'package-config'" class="panel">
        <h2>{{ id }} 包配置</h2>
        <button :disabled="!ready" @click="readConfig(id)">读取包配置</button>
        <template v-if="config.id === id">
          <p>读取版本：{{ config.revision ?? '需重新读取' }} · 应用状态：{{ config.apply }}</p>
          <label
            >JSON 配置<textarea v-model="config.text" rows="12" @input="config.dirty = true" />
          </label>
          <button
            :disabled="!ready || config.revision === null || !config.dirty"
            @click="saveConfig"
          >
            保存并回读
          </button>
        </template>
      </section>
    </div>
  </section>
</template>
