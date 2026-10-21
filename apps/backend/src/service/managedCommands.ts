import type { SenseRuntimeContext } from '@/core/sense/senseCreator.js'
import { getRootChatId } from '@/db/chat.js'
import { getActiveChatRunId } from './chat/runtimeCache.js'
import { getCommandRuntime } from './commands.js'
import type { RunningCommand } from './commandRuntime.js'
import type { ControllerSocketClient } from './managedApp/socketRpc.js'
import type { CommandTaskResult, ControllerCommandOutput } from './managedApp/types.js'
import { ManagedAppError } from './managedApp/types.js'
import type { BackendManagedTaskEvent } from '@chery/protocol'

interface Options<T> {
  client: ControllerSocketClient
  context?: SenseRuntimeContext
  task: { userId: string; appId: string; taskId: string }
  sourceKind: 'managed_exec' | 'managed_publish'
  command: string
  workdir?: string
  execute(output: ControllerCommandOutput): Promise<T>
  evidence(result: T): Pick<CommandTaskResult, 'status' | 'exitCode'>
}

function completed(command: RunningCommand | undefined, result: Pick<CommandTaskResult, 'status' | 'exitCode'>) {
  if (!command || result.status === 'running') return
  return command.finish({ status: result.status === 'cancelled' ? 'killed' : result.status === 'timed_out' ? 'timed_out' : 'exited',
    exitCode: result.exitCode })
}

/** Original output is collected independently of the controller's bounded Agent result preview. */
export async function runManagedCommand<T>(options: Options<T>): Promise<T> {
  const ctx = options.context
  ctx?.signal?.throwIfAborted()
  const runtime = ctx?.chatId ? getCommandRuntime() : undefined
  const cancel = async () => { await options.client.cancelAppCommand(options.task) }
  const command = runtime && ctx?.chatId ? runtime.start({
    chatId: ctx.chatId, rootChatId: getRootChatId(ctx.chatId), runId: getActiveChatRunId(ctx.chatId) ?? null,
    toolCallId: ctx.messageId ?? null, sourceKind: options.sourceKind, command: options.command,
    description: options.sourceKind === 'managed_publish' ? `发布应用 ${options.task.appId}` : `应用 ${options.task.appId} 的命令`,
    workdir: options.workdir ?? '/workspace',
  }, cancel) : undefined
  command?.started(options.task.taskId)
  const notify = (action: BackendManagedTaskEvent['action']) => {
    if (!command || !runtime || !process.connected) return
    try { process.send?.({ type: 'backend-managed-task', backendInstanceId: runtime.options.backendInstanceId,
      action, commandId: command.commandId, ...options.task }, () => {}) } catch { /* Parent retains existing registration on pipe loss. */ }
  }
  notify('register')
  const finish = async (result: Pick<CommandTaskResult, 'status' | 'exitCode'>) => {
    await completed(command, result)
    if (result.status !== 'running') notify('release')
  }
  const abort = () => { void (command ? command.requestCancel() : cancel()).catch(() => {}) }
  ctx?.signal?.addEventListener('abort', abort, { once: true })
  let watching = false
  let submitted = false
  const watch = () => {
    if (watching || !command) return
    watching = true
    const poll = async () => {
      if (command.snapshot().endedAt !== null) return
      try {
        const result = await options.client.getTaskStatus(options.task)
        if (result.status !== 'running') { await finish(result); return }
      } catch { /* An unavailable controller or unknown task is not process-exit evidence. */ }
      const timer = setTimeout(() => { void poll() }, 2000)
      timer.unref()
    }
    void poll()
  }
  try {
    if (ctx?.signal?.aborted) { abort(); ctx.signal.throwIfAborted() }
    submitted = true
    const result = await options.execute((stream, chunk) => command?.write(stream, chunk))
    const evidence = options.evidence(result)
    await finish(evidence)
    if (evidence.status === 'running') { command?.background(); watch() }
    return result
  } catch (error) {
    if (!submitted || error instanceof ManagedAppError && error.details?.executionNotStarted === true) {
      await command?.finish({ status: !submitted ? 'killed' : 'exited', exitCode: null })
      notify('release')
      throw error
    }
    // The execution request may have reached the controller. Only query that task; never resend it.
    if (!(error instanceof ManagedAppError) || error.code === 'CONTROLLER_UNAVAILABLE') command?.logTransportLost()
    let terminal = false
    try {
      const status = await options.client.getTaskStatus(options.task)
      if (status.status !== 'running') {
        await finish(status)
        terminal = true
        if (status.status === 'cancelled' && error instanceof Error) Object.assign(error, { managedCommandCancelled: true })
      }
    } catch { /* No replay. The parent keeps the registration until status evidence arrives. */ }
    if (!terminal) watch()
    throw error
  } finally {
    ctx?.signal?.removeEventListener('abort', abort)
  }
}
