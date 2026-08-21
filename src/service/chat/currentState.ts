import { getRecentChatEvents } from '@/db/delivery.js'
import { approvalManager } from '../approval/manager.js'
import { isChatRunning } from './runtime.js'
import { safeJsonParse } from '@/utils/json.js'
import type { CurrentStateData } from '../message/types.js'
import type { ToolAuthorization } from '@/core/security/rolePolicy.js'

/**
 * 计算刷新当前态快照（G8）。扫描近期 chat 事件 + 内存审批态，权威给出：
 * - pendingApproval：仍存活的挂起审批（approvalManager 内存命中）。park 不发 rejected 事件，
 *   故「审批是否仍可审批」只能靠内存判定，事件流推导不可靠。
 * - runningTools：已发 sense_end/sense_started 但无 accept/rejected 的工具（含待审批）。
 * - currentTodo：最近一条 update_todo 的结构化 todos（todo 无专用通知，靠 sense_end.arguments）。
 *
 * 事件流（chat.sync）仍是前端缓存数组的累积水源；本快照仅补事件无法可靠判定的事实。
 * 不含 currentTurnContent：当前轮 content 由事件流（stream delta + content_end）累积重建，
 * 快照会造成双内容源合并，违背单一缓存数组原则。
 */
export function computeCurrentState(chatId: string): CurrentStateData {
  const events = getRecentChatEvents(chatId, 500)
  const running = isChatRunning(chatId)

  type InterruptInfo = {
    approvalId: string
    senseName: string
    arguments: string
    supervisionLevel: number
    waitTime: number
    createdAt: number
    security?: ToolAuthorization
  }

  // 迭代近期事件（升序）：跟踪最近未决 interrupt + 未决 sense 调用 + 最近 todo
  let pendingInterrupt: InterruptInfo | undefined
  const runningToolsMap = new Map<string, { id: string; senseName: string }>()
  let currentTodo: unknown[] | undefined

  for (const ev of events) {
    const e = ev as Record<string, unknown>
    const kind = e.kind
    const type = e.type
    const data = (e.data ?? {}) as Record<string, unknown>

    if (kind === 'notification') {
      if (type === 'interrupt') {
        const id = data.approvalId as string | undefined
        if (id) {
          pendingInterrupt = {
            approvalId: id,
            senseName: (data.senseName as string) ?? '',
            arguments: (data.arguments as string) ?? '',
            supervisionLevel: (data.supervisionLevel as number) ?? 1,
            waitTime: (data.waitTime as number) ?? 0,
            createdAt: (data.createdAt as number) ?? 0,
            security: data.security as ToolAuthorization | undefined,
          }
          runningToolsMap.set(id, { id, senseName: (data.senseName as string) ?? '' })
        }
      } else if (type === 'accept' || type === 'rejected') {
        const id = data.approvalId as string | undefined
        if (id) {
          runningToolsMap.delete(id)
          if (pendingInterrupt?.approvalId === id) pendingInterrupt = undefined
        }
      } else if (type === 'sense_started') {
        // auto 工具运行信号（id 与 accept.approvalId 同源，accept 时移除）
        const id = data.id as string | undefined
        if (id) runningToolsMap.set(id, { id, senseName: (data.senseName as string) ?? '' })
      }
    } else if (kind === 'chunk' && type === 'staged') {
      if (data.type === 'sense_end') {
        const id = data.id as string | undefined
        const senseName = (data.senseName as string) ?? ''
        if (id) runningToolsMap.set(id, { id, senseName })
        if (senseName === 'update_todo') {
          const parsed = safeJsonParse<{ todos?: unknown[] }>((data.arguments as string) ?? '', {})
          if (Array.isArray(parsed?.todos)) currentTodo = parsed.todos
        }
      }
    }
  }

  // pendingApproval：仅当仍存活（未被 confirm/park/hard-timeout/超时清出）
  const pendingApproval =
    pendingInterrupt && approvalManager.has(pendingInterrupt.approvalId)
      ? pendingInterrupt
      : undefined

  // runningTools：仅 run 在跑时有意义（idle/parked 时无运行中工具）
  const runningTools = running ? Array.from(runningToolsMap.values()) : []

  const result: CurrentStateData = { runningTools }
  if (pendingApproval) result.pendingApproval = pendingApproval
  if (currentTodo) result.currentTodo = currentTodo
  return result
}
