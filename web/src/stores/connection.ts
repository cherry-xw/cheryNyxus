import { defineStore } from 'pinia'
import { ref } from 'vue'
import { wsClient, type ConnectionStatus, type RpcResponse } from '@/services/ws'

/**
 * 连接 store：管理 WebSocket 连接状态 + RPC 调用入口。
 */
export const useConnectionStore = defineStore('connection', () => {
  const status = ref<ConnectionStatus>('disconnected')
  const error = ref<string | null>(null)
  let initialized = false

  async function init(): Promise<void> {
    if (initialized) return
    initialized = true
    wsClient.onStatus((s) => {
      status.value = s
      if (s === 'connected') error.value = null
    })
    try {
      // 首次连接不 refresh：main 进程在创建窗口前已 waitForBackend 就绪，preload 注入的
      // __BACKEND_CONFIG__ 快照 token 有效，直接用快照建 WS（省一次 IPC 刷新）。
      // 即便快照 token 因罕见竞态失效，WS onclose → shouldReconnect → reconnect() 会
      // refresh 拿最新 token 兜底。注意不可在此强制 refresh——Electron 渲染进程刷新走
      // main 进程 IPC，若后端尚未就绪会整体失败且 init() 不重试，启动即断连。
      await wsClient.connect()
    } catch (e) {
      error.value = (e as Error).message
    }
  }

  async function rpc(method: string, params?: unknown): Promise<RpcResponse> {
    try {
      const response = await wsClient.rpc(method, params)
      return response
    } catch (e) {
      error.value = (e as Error).message
      throw e
    }
  }

  /**
   * 登录/登出后重建连接：重新拉取 /api/config（带新 token）+ 建立 WS。
   * bootstrap 首次 connect 因 401 失败后 serverConfig 仍为空，再次 connect 会重拉配置。
   */
  async function reconnect(): Promise<void> {
    // 已连接则跳过，避免创建重复 WS（本地直连场景登录面板重按时）。
    if (status.value === 'connected') return
    try {
      // refresh:true：手动重连必须拿最新 token（worker 重启会轮换 sessionToken），
      // 复用缓存的旧 token 会被服务端 401 拒绝——这是「断开后手动重连也失败」的根因。
      await wsClient.connect({ refresh: true })
    } catch (e) {
      error.value = (e as Error).message
    }
  }

  /** 登出后停止 WS 自动重连并断开（远端无 token 再连必 401）。 */
  function disconnect(): void {
    wsClient.disconnect()
    status.value = 'disconnected'
  }

  return { status, error, init, rpc, reconnect, disconnect }
})
