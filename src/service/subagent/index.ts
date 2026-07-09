import type { WebSocket } from "ws";
import type { RpcRouter } from "../message/router.js";
import { createNotification, type Notification } from "../message/types.js";
import { transport } from "../websocket/transport.js";
import { connectionManager } from "../websocket/connection.js";
import { setSpawnBroadcaster } from "@/agent/spawnBroker.js";
import { registerSubagentHandlers } from "./result.js";

export { registerSubagentHandlers, handleSubagentResult } from "./result.js";

/**
 * 安装 spawn broadcaster（service 启动期调用，注入 ws 推送实现）。
 *
 * spawnBroker 在 agent 层，不直接依赖 service/ws。service 层通过此函数把
 * 「推送 subagent_* notification 到主 chat 所属连接」的实现注入给 broker。
 *
 * CP6 扩展：broadcaster 同时承担 subagent_created 与 subagent_destroyed 推送，
 * 按 kind 判别 notification.type（避新建并行 destroyBroadcaster，规则 2 简洁优先）。
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
          `[spawnBroadcaster] 主 chat ${parentChatId} 无活跃连接，${kind === "created" ? "subagent_created" : "subagent_destroyed"} 通知未推送（chatId=${data.chatId}）`,
        );
        return;
      }
      // requestId = parentChatId：前端按 chatId 路由 notification 到对应主 agent 流
      // （sense handler 内无法取 WS 当前 requestId，故用 chatId 作关联键）
      const type = kind === "created" ? "subagent_created" : "subagent_destroyed";
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
 * 注册 subagent 相关 RPC handlers + 安装 broadcaster。
 * service/index.ts 启动期调用。
 */
export function registerSubagent(router: RpcRouter): void {
  registerSubagentHandlers(router);
  installSpawnBroadcaster();
}
