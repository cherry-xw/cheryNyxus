import { reactive, onMounted, onUnmounted } from 'vue'
import { managerRequest, onManagerSessionExpired } from './api'
import type { ManagerUiRegistration } from '../../protocol/src/ingress'
export function usePluginPage(id: string) {
  const state = reactive({
    module: null as ManagerUiRegistration | null,
    available: false,
    error: '',
  })
  let timer: ReturnType<typeof setInterval> | undefined
  async function refresh() {
    try {
      const { data } = await managerRequest<{ data: { modules: ManagerUiRegistration[] } }>(
        '/api/modules',
      )
      const module = data.modules.find((item) => item.descriptor.id === id)
      if (!module) throw new Error('插件页面已撤销；草稿仍保留，请返回插件管理。')
      if (
        state.module &&
        state.module.descriptor.resourceVersion !== module.descriptor.resourceVersion
      )
        throw new Error('页面资源版本已变化，请保留草稿后重新打开页面。')
      state.module = module
      state.available = true
      state.error = ''
    } catch (error) {
      state.available = false
      state.error = error instanceof Error ? error.message : '管理连接不可用'
    }
  }
  onMounted(() => {
    void refresh()
    timer = setInterval(() => void refresh(), 10000)
  })
  onUnmounted(() => clearInterval(timer))
  onManagerSessionExpired(() => {
    state.available = false
    state.error = 'Manager 登录已失效，请返回本体重新登录。'
  })
  return { state, refresh }
}
