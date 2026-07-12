import type { WebSocket } from "ws";
import { createNotification, type Notification } from "../message/types.js";
import { transport } from "../websocket/transport.js";
import { connectionManager } from "../websocket/connection.js";
import { setSpawnBroadcaster, setAsyncWakeHandler } from "@/agent/spawnBroker.js";
import { handleAsyncWakeTimeout } from "../chat/wake.js";

/**
 * 安装 spawn broadcaster（service 启动期调用，注入 ws 推送实现）。
 *
 * spawnBroker 在 agent 层，不直接依赖 service/ws。service 层通过此函数把
 * 「推送 role_* notification 到主 chat 所属连接」的实现注入给 broker。
 *
 * 主 chat 流活跃期间 chatId 一定有 connection 绑定（chat.send/resume bindChatConnection）。
 * 若主 chat 未绑定连接（异常路径）：warn + 不抛错，前端通过 chat.list/chat.get 重建子 pet。
 */
export function installSpawnBroadcaster(): void {
  setSpawnBroadcaster(
    (parentChatId, kind, data) => {
      const ws = connectionManager.findWsByChatId(parentChatId);
      if (!ws) {
        console.warn(
          `[spawnBroadcaster] 主 chat ${parentChatId} 无活跃连接，${kind === "created" ? "role_created" : "role_destroyed"} 通知未推送（chatId=${data.chatId}）`,
        );
        return;
      }
      // requestId = parentChatId：前端按 chatId 路由 notification 到对应主 agent 流
      const type = kind === "created" ? "role_created" : "role_destroyed";
      const notif: Notification = createNotification(type, parentChatId, data);
      sendNotification(ws, notif);
    },
  );
}

/**
 * 推送 notification 到 ws（兼容 binary/json 传输模式）。
 * ws.readyState 检查避免 OPEN 之外状态 send 抛错。
 */
function sendNotification(ws: WebSocket, notif: Notification): void {
  if (ws.readyState !== ws.OPEN) {
    return;
  }
  ws.send(transport.encode(notif));
}

/**
 * service 启动期安装 spawn 相关注入（无 RPC handler——历史 subagent.result RPC 已废弃）：
 * - installSpawnBroadcaster：role_created/destroyed notification 推送
 * - installAsyncWakeHandler：wait=true 看门狗超时回调（wakeParent 超时 + abort 子）
 * service/index.ts 启动期调用。
 */
export function registerRole(): void {
  installSpawnBroadcaster();
  setAsyncWakeHandler(handleAsyncWakeTimeout);
}
