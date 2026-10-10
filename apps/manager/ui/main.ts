import { createApp } from 'vue'
import App from './App.vue'
import '../../../packages/manager-ui/src/styles.css'

declare global {
  interface Window {
    __CHERY_MANAGER__?: { modules?: string[]; lanAccess?: boolean }
  }
}

export const managerModules = window.__CHERY_MANAGER__?.modules ?? []
export const lanAccess = window.__CHERY_MANAGER__?.lanAccess === true

createApp(App).mount('#app')
