import type { WebSocket } from 'ws'
import { createNotification, type Notification } from '../message/types.js'
import { transport } from '../websocket/transport.js'
import { connectionManager } from '../websocket/connection.js'
import {
  setSpawnBroadcaster,
  setAsyncWakeHandler,
  setEagerSpawnStarter,
} from '@/agent/spawnBroker.js'
import { handleAsyncWakeTimeout } from '../chat/wake.js'
import { runChildTaskInBackground } from '../chat/spawnEager.js'
import { appendChatEvent } from '@/db/delivery.js'

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
  setSpawnBroadcaster((parentChatId, kind, data) => {
    const ws = connectionManager.findWsByChatId(parentChatId)
    const type = kind === 'created' ? 'role_created' : 'role_destroyed'
    // role_* 为脱离 RPC 的异步事件：使用显式 chatId 路由，不再把 parentChatId 伪装为 requestId。
    const notif: Notification = createNotification(type, undefined, data, { chatId: parentChatId })
    // 先持久化再尝试推送。即使当前没有连接，chat.sync 也能恢复该生命周期事件。
    notif.seq = appendChatEvent(parentChatId, notif as unknown as Record<string, unknown>)
    if (!ws) {
      console.warn(
        `[spawnBroadcaster] 主 chat ${parentChatId} 无活跃连接，${kind === 'created' ? 'role_created' : 'role_destroyed'} 通知未推送（chatId=${data.chatId}）`,
      )
      return
    }
    sendNotification(ws, notif)
  })
}

/**
 * 推送 notification 到 ws（兼容 binary/json 传输模式）。
 * ws.readyState 检查避免 OPEN 之外状态 send 抛错。
 */
function sendNotification(ws: WebSocket, notif: Notification): void {
  if (ws.readyState !== ws.OPEN) {
    return
  }
  for (const routed of connectionManager.prepareSessionEvent(ws, notif)) {
    ws.send(transport.encode(routed as Notification))
  }
}

/**
 * 安装 spawn eager 启动器（spawn_role sense fire-and-forget 后台启动子 chat）。
 *
 * 动机：用户原设计要求「子 agent 与主 agent 走同一条 API」。原 chat.startSpawn 由前端驱动，
 *   一旦前端 RPC 失败（requestMap 时序 / 网络抖动 / 页面关闭），子 agent stream 永远不到前端。
 *   把启动收敛到 spawn_role sense 后端（service 层），端到端路径与 chat.send 相同：
 *     spawn_role 完成 → startChildEager(taskId, parentChatId) → runChildTaskInBackground →
 *     handleChatStartSpawn claim + handleChatSend 绑子 chatId + persistChatEvent + sendToWs(parent ws)。
 *
 * chat.startSpawn RPC 不删除（保留为 recovery：重连 / 抢占 / 已 finished 同步 / 流加入）。
 */
export function installEagerSpawnStarter(): void {
  setEagerSpawnStarter((taskId, parentChatId) => {
    // fire-and-forget：不等待，错误隔离在 runChildTaskInBackground 内部 try/catch。
    void runChildTaskInBackground(taskId, parentChatId)
  })
}

/**
 * service 启动期安装 spawn 相关注入（无 RPC handler——历史 subagent.result RPC 已废弃）：
 * - installSpawnBroadcaster：role_created/destroyed notification 推送
 * - installEagerSpawnStarter：spawn_role sense 内后台启动子 chat（不依赖前端 RPC）
 * - installAsyncWakeHandler：wait=true 看门狗超时回调（wakeParent 超时 + abort 子）
 * service/index.ts 启动期调用。
 */
export function registerRole(): void {
  installSpawnBroadcaster()
  installEagerSpawnStarter()
  setAsyncWakeHandler(handleAsyncWakeTimeout)
}
