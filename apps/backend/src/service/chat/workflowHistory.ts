import { z } from 'zod'
import type { WorkflowSnapshot } from '@chery/protocol'
import { getActiveChatEpoch, getFrozenChatSnapshot, listChatEpochs } from '@/db/epoch.js'

export function workflowResources(chatId: string, epochId?: string): WorkflowSnapshot['resources'] {
  const epoch =
    epochId ?? getActiveChatEpoch(chatId)?.epochId ?? listChatEpochs(chatId).at(-1)?.epochId
  const frozen = epoch ? getFrozenChatSnapshot(epoch, chatId) : undefined
  const summary = z
    .object({
      memoryCount: z.number().int().nonnegative(),
      skillCount: z.number().int().nonnegative(),
    })
    .safeParse(frozen?.resources.workflow)
  return { ...(summary.success ? summary.data : {}), loadedSkillsComplete: false }
}

export function workflowStageId(chatId: string, summaryId?: string): string {
  return `${chatId}:${summaryId ?? 'start'}`
}
