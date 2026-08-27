import 'highlight.js/styles/github.css'
import './styles/element/index.scss'
// dark/css-vars.css 必须在 theme.css 之前：官方深色变量（默认蓝）先落地，
// 由 theme.css 的 html.dark 块以同特异性覆盖为主题色调（见 styles/theme.css）。
import 'element-plus/theme-chalk/dark/css-vars.css'
import './styles/theme.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'

import App from './App.vue'
import { useAuthStore, useThemeStore } from '@/stores'
import { configureServiceAuth } from '@/services/authContext'

const app = createApp(App)
const pinia = createPinia()
app.use(pinia)
app.use(ElementPlus)
const auth = useAuthStore(pinia)
configureServiceAuth({
  isRemote: () => auth.isRemote,
  baseUrl: () => auth.getBaseUrl(),
  accessToken: () => auth.accessToken,
  headers: () => auth.authHeader(),
  refresh: () => auth.refresh(),
})
// 首渲前应用持久化的主题（data-theme + html.dark）
app.use({
  install(): void {
    useThemeStore(pinia).apply()
  },
})
app.mount('#app')
