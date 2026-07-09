import 'highlight.js/styles/github.css'
import './styles/element/index.scss'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'

import App from './App.vue'

const app = createApp(App)
app.use(createPinia())
app.use(ElementPlus)
app.mount('#app')
