import 'highlight.js/styles/github.css'
import './styles/element/index.scss'
import './styles/theme.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'

import App from './App.vue'
import { useThemeStore } from '@/stores'

const app = createApp(App)
app.use(createPinia())
app.use(ElementPlus)
// 首渲前应用持久化的主题（data-theme + html.dark）
app.use({
  install(): void {
    useThemeStore().apply()
  },
})
app.mount('#app')
