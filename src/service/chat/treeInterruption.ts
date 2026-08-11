import { getChat } from '@/db/chat.js'
import { getActiveTreeControl } from '@/db/treeControl.js'
import { safeJsonParse } from '@/utils/json.js'

export interface TreeInterruptionNotice {
  messageId: string
  content: string
}

/**
 * Build the stable system notice paired with the root input that starts work
 * after a tree pause. Keeping this derivation deterministic lets runtime
 * restoration recreate the notice if the process stopped after acknowledging
 * the user input but before checkpoint persisted the notice.
 */
export function buildTreeInterruptionNotice(
  rootChatId: string,
  commandId: string,
): TreeInterruptionNotice | undefined {
  const root = getChat(rootChatId)
  if (!root || root.parent_chat_id) return undefined
  const control = getActiveTreeControl(rootChatId)
  const interruptedChildren = control?.targets.filter(
    (target) =>
      target.chatId !== rootChatId &&
      (target.status === 'paused' || target.status === 'failed'),
  )
  if (!control || !interruptedChildren || interruptedChildren.length === 0) return undefined

  const childLines = interruptedChildren.map((target) => {
    const child = getChat(target.chatId)
    const metadata = child?.metadata
      ? (safeJsonParse(child.metadata, {}) as { type?: string })
      : {}
    return `- ${metadata.type ?? '协作节点'} (chatId: ${target.chatId})`
  })
  return {
    messageId: `tree-interruption:${control.pauseId}:${commandId}`,
    content: [
      '[任务树状态] 用户的新消息只恢复了主 Agent。',
      `暂停操作 ${control.pauseId} 仍有 ${interruptedChildren.length} 个子 Agent 任务处于中断状态：`,
      ...childLines,
      '请根据用户的新要求判断是否使用 send_to_child 恢复其中的任务；不要自动恢复无关任务。',
    ].join('\n'),
  }
}
