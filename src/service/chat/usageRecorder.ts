import { observeModelRequests } from '@/core/llm/usage.js'
import type { MiddlewareChunk } from '@/core/middleware/types.js'
import { saveRequestUsage, saveUsageOperation, type StoredUsageOperation } from '@/db/usage.js'
import { getActiveChatRunId } from './runtime.js'
import { resolveWorkflowIdentity } from './workflowStepWriter.js'
import { logger } from '@/utils/logger/index.js'

export function startUsageRecorder(chatId: string): {
  record(chunk: MiddlewareChunk): void
  close(): void
} {
  let attemptId: string | undefined
  const operations = new Map<string, StoredUsageOperation>()
  const safely = (work: () => void) => {
    try {
      work()
    } catch {
      logger.warn('上下文统计保存失败；不会影响任务执行')
    }
  }
  const identity = resolveWorkflowIdentity(chatId)
  const runId = getActiveChatRunId(chatId)
  const stop = observeModelRequests(chatId, (event) =>
    safely(() => {
      attemptId = event.attemptId
      saveRequestUsage({
        ...event,
        taskKey: identity.rootChatId,
        branchId: identity.branchId,
        runId,
      })
    }),
  )
  return {
    record(chunk) {
      safely(() => {
        if (chunk.type === 'sense_started') {
          const operation: StoredUsageOperation = {
            id: `${chatId}:${runId ?? ''}:${chunk.id}:${chunk.startedAt}`,
            taskKey: identity.rootChatId,
            chatId,
            attemptId,
            toolName: chunk.name,
            startedAt: chunk.startedAt,
            status: 'running',
          }
          operations.set(chunk.id, operation)
          saveUsageOperation(operation)
        } else if (chunk.type === 'sense_accept' || chunk.type === 'sense_reject') {
          const operation = operations.get(chunk.id)
          if (!operation) return
          operation.endedAt = Date.now()
          operation.status = chunk.type === 'sense_accept' ? 'completed' : 'rejected'
          saveUsageOperation(operation)
          operations.delete(chunk.id)
        }
      })
    },
    close() {
      stop()
      for (const operation of operations.values())
        safely(() => {
          saveUsageOperation({ ...operation, endedAt: Date.now(), status: 'interrupted' })
        })
      operations.clear()
    },
  }
}
