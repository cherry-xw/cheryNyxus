import { randomUUID } from 'crypto'
import { logger } from '@/utils/logger/index.js'
import { listOverdueApprovals, reconcileInteractionInbox, transitionInteraction } from '@/db/interaction.js'
import { approvalManager } from '../approval/manager.js'
import { launchDetachedResume } from '../chat/send.js'
import { broadcastInteractionChanged } from './events.js'

const recovering = new Set<string>()
let timer: ReturnType<typeof setInterval> | undefined

async function expireOne(interactionId: string, chatId: string): Promise<void> {
  if (recovering.has(interactionId)) return
  recovering.add(interactionId)
  try {
    if (!approvalManager.has(interactionId)) {
      await launchDetachedResume(
        { connectionId: 'interaction-deadline', log: logger },
        chatId,
        randomUUID(),
      )
      const startedAt = Date.now()
      while (!approvalManager.has(interactionId) && Date.now() - startedAt < 8000) {
        await new Promise((resolve) => setTimeout(resolve, 40))
      }
    }
    if (approvalManager.has(interactionId)) approvalManager.expire(interactionId)
    else {
      const blocked = transitionInteraction(interactionId, ['pending', 'resolving'], 'blocked', {
        reason: '审批已到期，但自动恢复失败；工具未执行',
      })
      broadcastInteractionChanged(blocked)
    }
  } catch (cause) {
    logger.event('interaction.deadline.failed', {
      interactionId,
      chatId,
      message: cause instanceof Error ? cause.message : String(cause),
    })
  } finally {
    recovering.delete(interactionId)
  }
}

async function sweep(): Promise<void> {
  await Promise.all(listOverdueApprovals().map((item) => expireOne(item.interactionId, item.chatId)))
}

export function startInteractionLifecycle(): void {
  if (timer) return
  reconcileInteractionInbox()
  void sweep()
  timer = setInterval(() => void sweep(), 1000)
}

export function stopInteractionLifecycle(): void {
  if (timer) clearInterval(timer)
  timer = undefined
}
