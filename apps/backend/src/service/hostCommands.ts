import { spawn, type ChildProcess } from 'node:child_process'
import type { BackendProcessEvent } from '@chery/protocol'
import type { RunningCommand } from './commandRuntime.js'

interface HostCommand {
  chatId: string
  child: ChildProcess
  command: RunningCommand
  requested: boolean
}

const processes = new Map<number, HostCommand>()

function notify(event: BackendProcessEvent): void {
  if (!process.connected) return
  try { process.send?.(event, () => {}) } catch { /* Worker admission closes on IPC disconnect. */ }
}

/** Shared by command.stop, worker force and the bash process-management view. */
export function requestHostCommandStop(pid: number): boolean {
  const entry = processes.get(pid)
  if (!entry) return false
  entry.requested = true
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error', () => {})
  } else {
    try { process.kill(-pid, 'SIGTERM') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
  }
  return true
}

export function registerHostCommand(chatId: string, child: ChildProcess, command: RunningCommand, instanceId: string): void {
  if (!child.pid) return
  processes.set(child.pid, { chatId, child, command, requested: false })
  notify({ type: 'backend-process', backendInstanceId: instanceId, kind: 'command',
    action: 'register', pid: child.pid, commandId: command.commandId })
}

export async function releaseHostCommand(pid: number, instanceId: string): Promise<void> {
  const entry = processes.get(pid)
  if (!entry) return
  // A shell may exit after starting children with redirected stdio. Keep the same
  // cancellation handle and command ownership until its ordinary process group is gone.
  if (process.platform !== 'win32') {
    const alive = () => {
      try { process.kill(-pid, 0); return true }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
    }
    if (alive()) entry.command.background()
    while (alive()) await new Promise<void>(resolve => { const timer = setTimeout(resolve, 100); timer.unref() })
  }
  if (processes.get(pid) !== entry) return
  processes.delete(pid)
  notify({ type: 'backend-process', backendInstanceId: instanceId, kind: 'command',
    action: 'release', pid, commandId: entry.command.commandId })
}

export function listHostCommands(chatId?: string) {
  return [...processes].filter(([, entry]) => !chatId || entry.chatId === chatId).map(([pid, entry]) => {
    const command = entry.command.snapshot()
    return { chatId: entry.chatId, pid, command: command.command, description: command.description,
      startedAt: command.startedAt, killed: entry.requested || command.status === 'cancel_requested', commandId: command.commandId }
  })
}

export function stopHostCommandForChat(chatId: string, pid: number): boolean {
  const entry = processes.get(pid)
  if (!entry || entry.chatId !== chatId) return false
  void entry.command.requestCancel().catch(() => {})
  return true
}
