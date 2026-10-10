import type { ConfigApplyState } from '@chery/protocol'

export type RestartStatus = 'immediate' | 'scheduled' | 'manual'
export type RestartState = ConfigApplyState['restart']
export type RestartBlocker = NonNullable<RestartState['blockers']>[number]

let state: RestartState = { required: false, status: 'none' }
let options:
  | {
      isIdle(): boolean
      blockers?(): RestartBlocker[]
      onRestartReady?(): void | Promise<void>
      validateBeforeRestart?(): { ok: true } | { ok: false; error?: string }
    }
  | undefined
const listeners = new Set<(state: RestartState) => void>()
const activities = new Set<RestartBlocker>()
let poll: ReturnType<typeof setInterval> | undefined

export function configureRestartCoordinator(input: NonNullable<typeof options>): void {
  options = input
}
export function getRestartState(): RestartState {
  return structuredClone(state)
}
export function subscribeRestartState(listener: (state: RestartState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
function publish(next: RestartState): void {
  if (JSON.stringify(next) === JSON.stringify(state)) return
  state = next
  for (const listener of listeners) {
    try {
      listener(getRestartState())
    } catch {
      /* Output failures cannot change restart safety. */
    }
  }
}
export function isRestartDraining(): boolean {
  return ['pending', 'blocked', 'ready'].includes(state.status)
}
export function assertRestartAdmission(existingWork = false): void {
  if (state.status === 'ready' || (isRestartDraining() && !existingWork))
    throw new Error('系统正在等待安全重启，暂不能开始新任务；可继续处理待办或管理后台进程')
}
/** Tracks actual completion, even when a caller stops awaiting a timed-out operation. */
export function trackRestartActivity(blocker: RestartBlocker): () => void {
  assertRestartAdmission(true)
  activities.add(blocker)
  notifyRestartActivityChanged()
  return () => {
    activities.delete(blocker)
    notifyRestartActivityChanged()
  }
}
function blockers(): RestartBlocker[] {
  return [
    ...activities,
    ...(options?.blockers?.() ?? []),
    ...(options?.isIdle() === false ? [{ kind: 'agent', description: '等待当前运行结束' }] : []),
  ]
}
export function cancelPendingRestart(): void {
  if (state.status === 'ready') return
  clearInterval(poll)
  poll = undefined
  publish({ required: false, status: 'none' })
}
export function requestRestartWhenIdle(): RestartStatus {
  if (state.status === 'ready') return 'immediate'
  if (!options?.onRestartReady) {
    publish({
      required: true,
      status: 'manual',
      reason: '当前未连接守护进程，请在任务和后台进程结束后手动重启',
    })
    return 'manual'
  }
  publish({ required: true, status: 'pending' })
  // Durable approvals/questions can change without a live generator callback.
  poll ??= setInterval(notifyIfReady, 250)
  poll.unref()
  setImmediate(notifyIfReady)
  try {
    return blockers().length ? 'scheduled' : 'immediate'
  } catch {
    return 'scheduled'
  }
}
export function notifyRestartActivityChanged(): void {
  if (isRestartDraining()) setImmediate(notifyIfReady)
}
function notifyIfReady(): void {
  if (!isRestartDraining() || state.status === 'ready') return
  try {
    const pending = blockers()
    if (pending.length) {
      publish({
        required: true,
        status: 'blocked',
        reason: '等待当前任务或后台进程结束',
        blockers: pending,
      })
      return
    }
    const check = options?.validateBeforeRestart?.()
    if (check && !check.ok) throw new Error(check.error ?? '重启预检失败')
    clearInterval(poll)
    poll = undefined
    publish({ required: true, status: 'ready' })
    void Promise.resolve(options?.onRestartReady?.()).catch(failRestart)
  } catch {
    failRestart()
  }
}

function failRestart(): void {
  clearInterval(poll)
  poll = undefined
  publish({
    required: true,
    status: 'failed',
    reason: '重启预检或通知失败；服务保持运行，请检查磁盘配置并重新保存。原文件未自动回滚。',
  })
}
