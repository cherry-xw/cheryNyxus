import net from 'node:net'
import { randomUUID } from 'node:crypto'
import type { BackendManagedTaskEvent } from '@chery/protocol'

/** Parent fallback speaks only the controller's existing fixed cancellation/status methods. */
async function call(method: 'cancelAppCommand' | 'getTaskStatus', task: BackendManagedTaskEvent): Promise<Record<string, unknown>> {
  const id = `rpc_${randomUUID().replace(/-/g, '').slice(0, 16)}`
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.CHERY_APP_CONTROLLER_SOCKET ?? '/run/cherynyxus-app-controller/controller.sock')
    let buffer = ''
    let settled = false
    const finish = (action: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      action()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('受管命令状态未获确认'))), 2000)
    timer.unref()
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(JSON.stringify({ id, method,
      params: { userId: task.userId, appId: task.appId, taskId: task.taskId } }) + '\n'))
    socket.on('data', chunk => {
      buffer += chunk
      if (buffer.length > 2 * 1024 * 1024) { finish(() => reject(new Error('受管命令响应过大'))); return }
      const end = buffer.indexOf('\n')
      if (end < 0) return
      try {
        const reply = JSON.parse(buffer.slice(0, end))
        if (reply.id !== id || reply.ok !== true || !reply.result || typeof reply.result !== 'object') throw new Error('受管命令状态未获确认')
        finish(() => resolve(reply.result))
      } catch (error) { finish(() => reject(error)) }
    })
    socket.once('error', error => finish(() => reject(error)))
    socket.once('close', () => finish(() => reject(new Error('受管命令控制连接已关闭'))))
  })
}

export async function cleanupManagedTask(task: BackendManagedTaskEvent): Promise<boolean> {
  await call('cancelAppCommand', task).catch(() => {})
  const result = await call('getTaskStatus', task)
  return result.taskId === task.taskId && result.userId === task.userId && result.appId === task.appId &&
    ['completed', 'failed', 'cancelled', 'timed_out', 'oom_killed'].includes(String(result.status)) && typeof result.finishedAt === 'number'
}
