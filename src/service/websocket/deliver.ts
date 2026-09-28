/**
 * WebSocket 事件投递的共享循环。
 *
 * 所有「向一批 chat 订阅连接推送一条事件」的写法都是同一套三步：
 * 过滤已关闭连接 → prepareSessionEvent 做 lite 投影/路由 → encode 后 send，
 * 发送失败只记日志不上抛（断连窗口由 `chat.sync` 回放补齐，不影响调用方）。
 * 此前该循环在 6 处逐字复制，此处为唯一实现；失败日志的事件名/级别由
 * 调用方传入，日志语义与各站点历史行为一致。
 */
import type { WebSocket } from 'ws'
import { connectionManager } from './connection.js'
import { transport } from './transport.js'
import { logger } from '@/utils/logger/index.js'
import { LogLevel } from '@/utils/logger/types.js'

/** 编码发送失败时的默认日志事件名。 */
const DEFAULT_FAILURE_EVENT = 'ws.event.failed'

/**
 * 解析实时输出目标 ws：chat.attach/liveOutput 重定向命中（按 event.chatId）→ 新连接 ws；
 * 否则回落启动 run 的捕获 ws。使刷新后新连接能接管仍在运行的 run 的后续输出。
 */
export function resolveOutputTargets(
  item: { chatId?: string },
  fallbackWs: WebSocket,
): WebSocket[] {
  return item.chatId ? connectionManager.getChatOutputs(item.chatId, fallbackWs) : [fallbackWs]
}

/**
 * 向一组 WebSocket 连接投递一条事件（已由调用方完成事件持久化等前置）。
 *
 * @param targets 目标连接集合（通常是 connectionManager.getChatOutputs 的结果）
 * @param item 待投递事件（Notification / Chunk 等已构造好的帧载荷）
 * @param failureEvent 发送失败时记录的日志事件名（各站点保留原事件名）
 * @param failureLevel 失败日志级别（与历史站点行为一致）
 * @param failureData 附加到失败日志的上下文字段（如 chatId）
 */
export function deliverToSockets(
  targets: readonly WebSocket[],
  item: unknown,
  failureEvent: string = DEFAULT_FAILURE_EVENT,
  failureLevel: LogLevel = LogLevel.info,
  failureData: Record<string, unknown> = {},
): void {
  for (const ws of targets) {
    if (ws.readyState !== ws.OPEN) continue
    for (const routed of connectionManager.prepareSessionEvent(ws, item)) {
      try {
        ws.send(transport.encode(routed as Parameters<typeof transport.encode>[0]))
      } catch (err) {
        logger.event(failureEvent, { ...failureData, message: (err as Error).message }, failureLevel)
      }
    }
  }
}
