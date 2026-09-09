import {
  Method,
  WorkflowOpenResponseSchema,
  WorkflowCloseResponseSchema,
  WorkflowHistoryResponseSchema,
  WorkflowUpdatedSchema,
  type WorkflowHistoryRequest,
  type WorkflowOpenRequest,
} from '@chery/protocol'
import { wsClient } from './ws'
import type { z } from 'zod'

async function call<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T> {
  const response = await wsClient.rpc(method, params)
  if (!response.success) throw new Error(response.error?.message || '运行流程加载失败，请重试')
  return schema.parse(response.data)
}

export const workflowApi = {
  open: (data: WorkflowOpenRequest) =>
    call(Method.CHAT_WORKFLOW_OPEN, data, WorkflowOpenResponseSchema),
  close: (subscriptionId: string) =>
    call(Method.CHAT_WORKFLOW_CLOSE, { subscriptionId }, WorkflowCloseResponseSchema),
  history: (data: WorkflowHistoryRequest) =>
    call(Method.CHAT_WORKFLOW_HISTORY, data, WorkflowHistoryResponseSchema),
  connected: () => wsClient.getStatus() === 'connected',
  onStatus: (callback: (connected: boolean) => void) =>
    wsClient.onStatus((status) => callback(status === 'connected')),
  onUpdate: (callback: (event: z.infer<typeof WorkflowUpdatedSchema>) => void) =>
    wsClient.onNotification((notification) => {
      if (
        !notification ||
        typeof notification !== 'object' ||
        !('type' in notification) ||
        notification.type !== 'workflow.updated' ||
        !('data' in notification)
      )
        return
      const parsed = WorkflowUpdatedSchema.safeParse(notification.data)
      if (parsed.success) callback(parsed.data)
    }),
}
