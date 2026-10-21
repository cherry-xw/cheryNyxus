import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import { BackendLifecycleRequestSchema, type BackendStopBlocker, type BackendStopSnapshot } from '@chery/protocol'
import { BackendResumeRepository } from '@/db/backendResume.js'
import { getChat } from '@/db/chat.js'
import { listLatestExecutionRunsAcrossRoots } from '@/db/executionGraph.js'
import { chatRuntimes, abortAllChatRuntimes } from './chat/runtimeCache.js'
import { isReservedInputId } from '@/core/middleware/inputAdoption.js'
import { configureBackendWork, getBackendPluginBlockers } from './backendWork.js'
import { BackendStopCoordinator } from './backendStopCoordinator.js'
import { getRestartActivityEntries, setBackendStopPriority } from './restartCoordinator.js'
import { getBashProcessActivity, killBashProcess } from '@/agent/sense/processRegistry.js'
import { recoverInterruptedTools } from './chat/toolRecovery.js'

interface Options {
  db: Database.Database
  backendInstanceId: string
  close(): Promise<void>
  forceCommands?(): Promise<void>
  commandBlockers?(): BackendStopBlocker[]
  configApplying(): boolean
  wakeQueued(chatId: string): Promise<void>
  publish(state: BackendStopSnapshot): void
  error(error: unknown): void
}

/** Binds admission, durable restart gates, current-work continuation and worker control IPC. */
export function createWorkerLifecycle(options: Options) {
  const resume = new BackendResumeRepository(options.db)
  const adopted = new Set<string>()
  const beforeStop = new Set<string>()
  let waking: string[] = []
  let unknownPoll: ReturnType<typeof setInterval> | undefined
  const syncUnknown = () => {
    if (coordinator.snapshot().phase !== 'force_stopping') return
    const started = options.db.prepare('SELECT call_id, name FROM tool_execution_starts').all() as { call_id: string; name: string }[]
    coordinator.replaceUnknown([...getRestartActivityEntries(), ...started.map(entry => ({ id: `tool:${entry.call_id}`,
      description: `工具 ${entry.name} 的结果未确认；不会自动重放` }))])
  }
  const pending = () => options.db.prepare(`SELECT input_id, chat_id FROM pending_inputs
    WHERE state IN ('accepted', 'started', 'queued')`).all() as { input_id: string; chat_id: string }[]
  const continuation = (chatId: string): boolean => {
    let id: string | undefined = chatId
    const seen = new Set<string>()
    while (id && !seen.has(id)) {
      if (adopted.has(id)) return true
      seen.add(id)
      id = getChat(id)?.parent_chat_id ?? undefined
    }
    return false
  }
  const coordinator = new BackendStopCoordinator({
    backendInstanceId: options.backendInstanceId,
    parkInputs(operationId) {
      setBackendStopPriority(true)
      for (const run of listLatestExecutionRunsAcrossRoots()) {
        if (['running', 'waiting'].includes(run.status)) adopted.add(run.chatId)
      }
      for (const [chatId, runtime] of chatRuntimes) {
        if (runtime.activeRunId || runtime.builder.isRunning()) {
          adopted.add(chatId)
          beforeStop.add(chatId)
        }
      }
      const waiting = options.db.prepare(`SELECT DISTINCT chat_id FROM interactions
        WHERE status IN ('pending', 'resolving', 'blocked')`).all() as { chat_id: string }[]
      for (const item of waiting) adopted.add(item.chat_id)
      const queued = pending().filter((entry) => !isReservedInputId(entry.input_id))
      resume.park([...queued.map((entry) => entry.chat_id), ...adopted], operationId)
      return queued.length
    },
    restoreInputs(operationId) { waking = resume.cancel(operationId) },
    blockers() {
      const blockers: BackendStopBlocker[] = []
      const latest = listLatestExecutionRunsAcrossRoots()
      for (const [chatId, runtime] of chatRuntimes) {
        if (runtime.activeRunId || runtime.builder.isRunning()) blockers.push({ id: `run:${chatId}`,
          chatId, kind: 'agent', description: '等待当前已采用任务及其结果处理完成' })
      }
      for (const run of latest) {
        if (continuation(run.chatId) && ['running', 'waiting'].includes(run.status) && !blockers.some((item) => item.chatId === run.chatId))
          blockers.push({ id: `wait:${run.chatId}`, chatId: run.chatId, kind: 'agent', description: '等待当前任务的子任务或结果回传' })
      }
      const interactions = options.db.prepare(`SELECT interaction_id AS id, chat_id, kind FROM interactions
        WHERE status IN ('pending', 'resolving', 'blocked')`).all() as { id: string; chat_id: string; kind: string }[]
      for (const item of interactions) if (continuation(item.chat_id)) blockers.push({ id: `interaction:${item.id}`,
        chatId: item.chat_id, kind: item.kind === 'question_batch' ? 'question' : 'approval', description: '等待当前任务的问题或审批处理完成' })
      for (const item of getRestartActivityEntries()) blockers.push({ id: item.id,
        kind: 'external', description: item.description ?? '等待已开始的操作结束' })
      if (options.configApplying()) blockers.push({ id: 'config', kind: 'config', description: '等待正在保存的配置完成' })
      blockers.push(...getBackendPluginBlockers())
      blockers.push(...(options.commandBlockers?.() ?? getBashProcessActivity().map((entry) => ({
        id: `bash:${entry.pid}`, kind: 'command' as const, chatId: entry.chatId, description: entry.description || '等待后台命令结束',
      }))))
      return blockers
    },
    close: () => options.close(),
    force: async () => {
      syncUnknown()
      unknownPoll ??= setInterval(syncUnknown, 100)
      unknownPoll.unref()
      abortAllChatRuntimes()
      for (const item of getBashProcessActivity()) killBashProcess(item.chatId, item.pid)
      // Network/plugin cleanup starts immediately; a non-cooperative command cannot extend the parent deadline.
      await Promise.all([options.close(), options.forceCommands?.()])
    },
  })
  configureBackendWork({ coordinator, resume, canContinue: continuation })
  coordinator.subscribe((state) => {
    options.publish(state)
    if (state.phase === 'running') {
      setBackendStopPriority(false)
      const restartQueued = [...new Set([...waking, ...beforeStop])]
      waking = []
      beforeStop.clear()
      adopted.clear()
      for (const chatId of restartQueued) {
        if (resume.required(chatId)) continue
        const runtime = chatRuntimes.get(chatId)
        if (!runtime || runtime.activeRunId || runtime.builder.isRunning() || !runtime.builder.getPendingInputs().length) continue
        void options.wakeQueued(chatId).catch(options.error)
      }
    }
  })

  const receive = (message: unknown) => {
    const parsed = BackendLifecycleRequestSchema.safeParse(message)
    if (!parsed.success) return
    const request = parsed.data
    if (request.backendInstanceId !== options.backendInstanceId) { options.publish(coordinator.snapshot()); return }
    try {
      if (request.type === 'stop-drain') coordinator.request(request.operationId)
      else if (request.type === 'stop-cancel') coordinator.cancel(request.operationId)
      else if (request.type === 'stop-force') coordinator.force(request.operationId, request.deadlineAt)
      else options.publish(coordinator.snapshot())
    } catch (error) { options.error(error); options.publish(coordinator.snapshot()) }
  }
  process.on('message', receive)
  const disconnected = () => coordinator.setConnection(false)
  process.on('disconnect', disconnected)
  const signal = () => coordinator.force(coordinator.snapshot().operationId ?? randomUUID())
  process.on('SIGINT', signal)
  process.on('SIGTERM', signal)

  return {
    coordinator,
    syncUnknown,
    /** Call before any startup recovery callback, scheduler or plugin can execute business work. */
    recover() {
      recoverInterruptedTools()
      const runs = listLatestExecutionRunsAcrossRoots().filter((run) => ['running', 'waiting', 'paused'].includes(run.status))
      const parents = options.db.prepare(`SELECT parent_chat_id FROM spawn_tasks WHERE status IN ('pending', 'started')`)
        .all() as { parent_chat_id: string }[]
      const children = options.db.prepare(`SELECT child_chat_id FROM spawn_tasks WHERE status IN ('pending', 'started')`)
        .all() as { child_chat_id: string }[]
      resume.recover([...pending().map((item) => item.chat_id), ...runs.map((run) => run.chatId),
        ...parents.map((item) => item.parent_chat_id), ...children.map((item) => item.child_chat_id)])
    },
    dispose() {
      coordinator.dispose()
      clearInterval(unknownPoll)
      process.off('message', receive)
      process.off('disconnect', disconnected)
      process.off('SIGINT', signal)
      process.off('SIGTERM', signal)
      configureBackendWork(undefined)
    },
  }
}
