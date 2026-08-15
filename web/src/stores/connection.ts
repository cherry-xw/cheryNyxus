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
    })
    try {
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
      await wsClient.connect()
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
