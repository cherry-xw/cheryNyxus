import { defineStore } from "pinia";
import { ref } from "vue";
import { wsClient, type ConnectionStatus, type RpcResponse } from "@/services/ws";

/**
 * 连接 store：管理 WebSocket 连接状态 + RPC 调用入口。
 */
export const useConnectionStore = defineStore("connection", () => {
  const status = ref<ConnectionStatus>("disconnected");
  const error = ref<string | null>(null);
  let initialized = false;

  async function init(): Promise<void> {
    if (initialized) return;
    initialized = true;
    wsClient.onStatus((s) => {
      status.value = s;
    });
    try {
      await wsClient.connect();
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function rpc(method: string, params?: unknown): Promise<RpcResponse> {
    try {
      const response = await wsClient.rpc(method, params);
      return response;
    } catch (e) {
      error.value = (e as Error).message;
      throw e;
    }
  }

  return { status, error, init, rpc };
});
