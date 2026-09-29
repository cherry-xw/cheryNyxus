<script setup lang="ts">
import { getCurrentInstance, shallowRef } from 'vue'
import type { Component, Ref } from 'vue'
import PreloadLoginShell from '@/features/auth/PreloadLoginShell.vue'

const businessApp: Ref<Component | null> = shallowRef(null)
const loadingBusiness = shallowRef(false)
const appInstance = getCurrentInstance()?.appContext.app

async function loadBusinessApp(): Promise<void> {
  if (businessApp.value || loadingBusiness.value) return
  loadingBusiness.value = true
  try {
    await Promise.all([
      import('./styles/element/index.scss'),
      import('element-plus/theme-chalk/dark/css-vars.css'),
      import('./styles/theme.css'),
      import('highlight.js/styles/github.css'),
    ])
    const element = await import('element-plus')
    for (const component of [
      element.ElAvatar,
      element.ElButton,
      element.ElCard,
      element.ElCascader,
      element.ElCheckbox,
      element.ElCheckboxGroup,
      element.ElDialog,
      element.ElDropdown,
      element.ElDropdownMenu,
      element.ElIcon,
      element.ElImageViewer,
      element.ElInput,
      element.ElInputNumber,
      element.ElLoading,
      element.ElOption,
      element.ElPopconfirm,
      element.ElPopover,
      element.ElSelect,
      element.ElSwitch,
      element.ElTag,
      element.ElTooltip,
    ]) {
      const componentName = (component as unknown as { name?: string }).name
      if (componentName) appInstance?.component(componentName, component)
    }
    appInstance?.use(element.ElLoading)
    const [{ default: businessComponent }, { setupGsapCore }, { setupMermaidAutoRender }] = await Promise.all([
      import('./App.vue'),
      import('./utils/gsapCore'),
      import('./utils/mermaidRenderer'),
    ])
    setupGsapCore()
    setupMermaidAutoRender()
    businessApp.value = businessComponent as Component
  } finally {
    loadingBusiness.value = false
  }
}
</script>

<template>
  <component :is="businessApp" v-if="businessApp" />
  <div v-else-if="loadingBusiness" class="business-loading" role="status">正在加载工作台…</div>
  <PreloadLoginShell v-else @ready="loadBusinessApp" />
</template>

<style>
html, body, #app { width: 100%; height: 100%; margin: 0; }
body { overflow: hidden; background: #101316; }
.business-loading { min-height: 100%; display: grid; place-items: center; color: #cbd2d6; font: 14px system-ui, sans-serif; }
</style>
