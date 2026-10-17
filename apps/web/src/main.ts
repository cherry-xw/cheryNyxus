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
  contextKey: () => JSON.stringify([auth.getBaseUrl(), auth.backendId, auth.mode, auth.username, auth.loggedIn]),
  assertCurrent: () => { if (!auth.loggedIn) throw new Error('请先登录当前后端') },
})
app.mount('#app')
