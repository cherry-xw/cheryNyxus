import { createApp } from 'vue'
import { createPinia } from 'pinia'
import PreloadRoot from './PreloadRoot.vue'
import { useAuthStore } from './stores/auth'
import { configureServiceAuth } from '@/services/authContext'

const app = createApp(PreloadRoot)
const pinia = createPinia()
app.use(pinia)
const auth = useAuthStore(pinia)
configureServiceAuth({
  isRemote: () => auth.isRemote,
  baseUrl: () => auth.getBaseUrl(),
  accessToken: () => auth.accessToken,
  headers: () => auth.authHeader(),
  refresh: () => auth.refresh(),
})
app.mount('#app')
