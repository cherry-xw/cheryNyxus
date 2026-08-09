import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { SupervisionLevel } from '@/core/config'
import { sense, type SenseResult, type SenseSharedData } from '@/core/sense'
import { stopChildAgents } from '@/service/chat/childControl.js'
import { dispatchToChild } from '@/service/chat/handler.js'

const stopChildSense = sense(
  'stop_child',
  '停止当前主会话下指定的子 Agent。recursive=true 时按孙到子的顺序停止整棵子树；重复工具调用使用稳定 command ID，不会重复写事实。',
  z.object({
    childChatId: z.string().min(1).describe('目标子 Agent 的 chatId'),
    recursive: z.boolean().default(false).describe('是否递归停止目标的全部后代'),
  }),
  async (input, shared: SenseSharedData, ctx): Promise<SenseResult> => {
    void shared
    if (!ctx?.chatId) throw new Error('stop_child 缺少主 chatId')
    const commandId = ctx.messageId ?? `stop-child:${randomUUID()}`
    const response = stopChildAgents({
      rootChatId: ctx.chatId,
      childChatId: input.childChatId,
      commandId,
      recursive: input.recursive,
    })
    return { content: JSON.stringify(response) }
  },
  SupervisionLevel.auto,
)

const sendToChildSense = sense(
  'send_to_child',
  '向当前主会话下已创建的子 Agent 派发后续任务。running 子任务进入队列；paused 子创建新 turn 并恢复；finished/failed/redirected 子保持只读并返回拒绝。',
  z.object({
    childChatId: z.string().min(1).describe('目标子 Agent 的 chatId'),
    content: z.string().min(1).describe('要派发给子 Agent 的完整任务'),
  }),
  async (input, shared: SenseSharedData, ctx): Promise<SenseResult> => {
    void shared
    if (!ctx?.chatId) throw new Error('send_to_child 缺少主 chatId')
    const commandId = ctx.messageId ?? `send-to-child:${randomUUID()}`
    const response = await dispatchToChild({
      rootChatId: ctx.chatId,
      childChatId: input.childChatId,
      commandId,
      content: input.content,
    })
    return { content: JSON.stringify(response) }
  },
  SupervisionLevel.auto,
)

export default [stopChildSense, sendToChildSense]
