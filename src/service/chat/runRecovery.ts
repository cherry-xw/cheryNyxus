import {
  listLatestExecutionRunsAcrossRoots,
  type ExecutionActiveRunRow,
} from '@/db/executionGraph.js'
import { getChat } from '@/db/chat.js'
import { getActiveChatRunId } from './runtime.js'
import { recordTerminationFact } from './executionFacts.js'

export interface RunRecoveryOptions {
  runs?: ExecutionActiveRunRow[]
  isLive?: (run: ExecutionActiveRunRow) => boolean
}

/**
 * A process restart destroys every in-memory generator. Durable running/waiting rows from the
 * previous process must therefore become paused recovery facts; otherwise timeline consumers
 * keep rendering a live CRT and replace the Resume action with Pause forever.
 */
export function reconcileOrphanedExecutionRuns(
  options: RunRecoveryOptions = {},
): ExecutionActiveRunRow[] {
  const runs = options.runs ?? listLatestExecutionRunsAcrossRoots()
  const isLive =
    options.isLive ?? ((run: ExecutionActiveRunRow) => getActiveChatRunId(run.chatId) === run.runId)
  const recovered: ExecutionActiveRunRow[] = []
  for (const run of runs) {
    if (
      (run.status !== 'running' && run.status !== 'waiting') ||
      !getChat(run.chatId) ||
      isLive(run)
    )
      continue
    recordTerminationFact({
      chatId: run.chatId,
      runId: run.runId,
      actor: 'system',
      code: 'system_stop',
      detail: 'service restarted before this run completed',
    })
    recovered.push({ ...run, status: 'paused' })
  }
  return recovered
}
