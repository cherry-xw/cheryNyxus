/**
 * Worker 内的受控重启协调器。
 *
 * 配置保存发生在 WebSocket 请求中，不能同步退出进程，否则客户端收不到成功响应。
 * 因此只标记一次待重启，并在下一轮事件循环（响应已写出）且所有 chat 空闲时，
 * 通过注入的回调通知守护进程替换 worker。
 */
export type RestartStatus = 'immediate' | 'scheduled' | 'manual'

let restartRequested = false
let restartNotified = false
let isIdle: (() => boolean) | undefined
let onRestartReady: (() => void) | undefined

export function configureRestartCoordinator(options: {
  isIdle: () => boolean
  onRestartReady?: () => void
}): void {
  isIdle = options.isIdle
  onRestartReady = options.onRestartReady
}

/** 标记待重启；无守护 IPC 时保留原有的“需手动重启”语义。 */
export function requestRestartWhenIdle(): RestartStatus {
  if (!onRestartReady) return 'manual'
  restartRequested = true
  const immediate = isIdle?.() === true
  setImmediate(notifyIfReady)
  return immediate ? 'immediate' : 'scheduled'
}

/** chat 运行状态变化后调用，检查是否已达到安全重启条件。 */
export function notifyRestartActivityChanged(): void {
  // releaseChatRun 的 finally 可能早于 AgentSession 清掉 isRunning 标记；
  // 延后一轮保证读取到最终空闲状态。
  if (restartRequested) setImmediate(notifyIfReady)
}

function notifyIfReady(): void {
  if (!restartRequested || restartNotified || !isIdle || !isIdle()) return
  restartNotified = true
  onRestartReady?.()
}
