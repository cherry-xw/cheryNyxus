import net from 'node:net'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, unlink } from 'node:fs/promises'
import {
  ManagedAppError,
  ControllerOutputFrameSchema,
  controllerRpcRequestSchema,
  type AppRuntimeStatus,
  type CommandTaskResult,
  type ControllerCommandOutput,
  type ControllerRpcRequest,
  type ControllerRpcResponse,
  type ParentResourceSnapshot,
  type StopReason,
} from './types.ts'
import type { ManagedAppController } from './controller.ts'

export const DEFAULT_CONTROLLER_SOCKET_PATH =
  process.env.CHERY_APP_CONTROLLER_SOCKET ??
  '/run/cherynyxus-app-controller/controller.sock'

/**
 * 启动受限控制器 Unix Domain Socket 服务端
 * 只接受 controllerRpcRequestSchema 校验通过的固定 JSON RPC，不暴露原始 Docker API
 */
export async function startControllerSocketServer(
  controller: ManagedAppController,
  socketPath = DEFAULT_CONTROLLER_SOCKET_PATH,
): Promise<{ server: net.Server; close: () => Promise<void> }> {
  await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o755 })
  await unlink(socketPath).catch(() => {})

  const server = net.createServer(socket => {
    socket.on('error', () => { /* A lost output viewer must not terminate controller execution. */ })
    let buffer = ''
    let accepted = false
    socket.setEncoding('utf8')

    socket.on('data', async chunk => {
      if (accepted) return
      buffer += chunk
      if (buffer.length > 512 * 1024) {
        const resp: ControllerRpcResponse = {
          id: 'overflow',
          ok: false,
          error: {
            code: 'INVALID_INPUT',
            message: 'RPC 请求体积超出 512 KiB 限制',
          },
        }
        socket.end(JSON.stringify(resp) + '\n')
        return
      }

      const newlineIdx = buffer.indexOf('\n')
      if (newlineIdx === -1) return

      const rawLine = buffer.slice(0, newlineIdx).trim()
      buffer = buffer.slice(newlineIdx + 1)
      accepted = true

      let reqId = 'unknown'
      try {
        const parsedJson = JSON.parse(rawLine)
        if (parsedJson && typeof parsedJson.id === 'string') {
          reqId = parsedJson.id
        }
        const validated = controllerRpcRequestSchema.parse(parsedJson)
        const result = await controller.dispatchRpc(validated, (stream, chunk) => {
          for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
            if (socket.destroyed) return
            // Drop the connection, not command output or execution, if the receiver cannot keep up.
            // Backend records transport loss and queries the existing task rather than replaying it.
            if (socket.writableLength > 1024 * 1024) { socket.destroy(); return }
            socket.write(JSON.stringify({ id: validated.id, type: 'command-output', stream,
              dataBase64: chunk.subarray(offset, offset + 64 * 1024).toString('base64') }) + '\n')
          }
        })
        const resp: ControllerRpcResponse = {
          id: validated.id,
          ok: true,
          result,
        }
        socket.end(JSON.stringify(resp) + '\n')
      } catch (err) {
        const resp: ControllerRpcResponse =
          err instanceof ManagedAppError
            ? {
                id: reqId,
                ok: false,
                error: {
                  code: err.code,
                  message: err.message,
                  details: err.details,
                },
              }
            : {
                id: reqId,
                ok: false,
                error: {
                  code: 'INVALID_INPUT',
                  message: err instanceof Error ? err.message : String(err),
                },
              }
        socket.end(JSON.stringify(resp) + '\n')
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  // 允许 UID 1000 (Backend) 读写该受控 Unix Socket
  await chmod(socketPath, 0o660).catch(() => {})

  return {
    server,
    close: () =>
      new Promise<void>(resolve => {
        server.close(() => {
          unlink(socketPath)
            .catch(() => {})
            .finally(() => resolve())
        })
      }),
  }
}

/**
 * Backend 侧调用受限控制器的 Unix Socket 客户端
 */
export class ControllerSocketClient {
  private readonly socketPath: string

  constructor(socketPath = DEFAULT_CONTROLLER_SOCKET_PATH) {
    this.socketPath = socketPath
  }

  async call<T = unknown>(
    method: ControllerRpcRequest['method'],
    params: Record<string, unknown>,
    timeoutMs = 320_000,
    onOutput?: ControllerCommandOutput,
  ): Promise<T> {
    const id = `rpc_${randomUUID().replace(/-/g, '').slice(0, 16)}`
    const payload = JSON.stringify({ id, method, params }) + '\n'

    return new Promise<T>((resolve, reject) => {
      const socket = net.createConnection(this.socketPath)
      let buffer = ''
      let settled = false

      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        socket.destroy()
        fn()
      }

      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new ManagedAppError(
              'CONTROLLER_UNAVAILABLE',
              `调用受管应用控制器超时 (${method})`,
            ),
          ),
        )
      }, timeoutMs)

      socket.setEncoding('utf8')
      socket.once('connect', () => {
        socket.write(payload)
      })

      socket.on('data', chunk => {
        buffer += chunk
        if (buffer.length > 8 * 1024 * 1024) {
          finish(() => reject(new ManagedAppError('CONTROLLER_UNAVAILABLE', '控制器响应过大，执行结果需另行查询')))
          return
        }
        let idx: number
        while (!settled && (idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim()
          buffer = buffer.slice(idx + 1)
          try {
            const parsed = JSON.parse(line) as ControllerRpcResponse<T> & { type?: string }
            if (parsed.id !== id) throw new Error('响应身份不匹配')
            if (parsed.type === 'command-output') {
              const frame = ControllerOutputFrameSchema.parse(parsed)
              try { onOutput?.(frame.stream, Buffer.from(frame.dataBase64, 'base64')) }
              catch { /* Collector failure is not command failure. */ }
              continue
            }
            if (parsed.ok) {
              finish(() => resolve(parsed.result))
            } else {
              finish(() => reject(
                new ManagedAppError(
                  parsed.error.code,
                  parsed.error.message,
                  parsed.error.details,
                ),
              ))
            }
          } catch (err) {
            finish(() => reject(
              new ManagedAppError(
                'CONTROLLER_UNAVAILABLE',
                '解析控制器响应失败，执行结果需另行查询',
              ),
            ))
          }
        }
      })

      socket.once('close', () => finish(() => reject(new ManagedAppError('CONTROLLER_UNAVAILABLE',
        '控制器连接已关闭，执行结果需另行查询'))))

      socket.once('error', err => {
        finish(() =>
          reject(
            new ManagedAppError(
              'CONTROLLER_UNAVAILABLE',
              `连接受管应用控制器失败 (${this.socketPath}): ${err.message}`,
            ),
          ),
        )
      })
    })
  }

  ensureAppWorkspace(params: {
    userId: string
    appId: string
    title: string
    description?: string
    visibility?: 'private' | 'public_read'
    creatorChannel?: {
      channel: 'qq'
      selfId: string
      userId: string
      conversationType: 'private' | 'group'
      groupId?: string
    }
  }) {
    return this.call<{
      appId: string
      userId: string
      state: string
      appUrl: string
      workspaceRoot: string
      dataRoot: string
      templateVersion: string
      leaseExpiresAt: number
      projectId: number
    }>('ensureAppWorkspace', params)
  }

  runAppCommand(params: {
    userId: string
    appId: string
    command: string
    taskId?: string
    cwd?: string
    profile?: 'standard' | 'build'
    timeoutSec?: number
  }, onOutput?: ControllerCommandOutput) {
    return this.call<CommandTaskResult>('runAppCommand', params, 320_000, onOutput)
  }

  getTaskStatus(params: { userId: string; appId: string; taskId: string }) {
    return this.call<CommandTaskResult>('getTaskStatus', params, 5000)
  }

  cancelAppCommand(params: { userId: string; appId: string; taskId: string }) {
    return this.call<{ taskId: string; status: 'cancelled' }>(
      'cancelAppCommand',
      params,
      5000,
    )
  }

  startAppService(params: {
    userId: string
    appId: string
    buildFirst?: boolean
    taskId?: string
  }, onOutput?: ControllerCommandOutput) {
    return this.call<{
      appId: string
      userId: string
      state: 'running'
      appUrl: string
      activationUrl?: string
      containerIp: string | null
      health: 'ok'
      leaseExpiresAt: number
      idleTimeoutHours: number
    }>('startAppService', params, 320_000, onOutput)
  }

  stopAppService(params: {
    userId: string
    appId: string
    reason?: StopReason
  }) {
    return this.call<{
      appId: string
      userId: string
      state: 'stopped'
      stopReason: StopReason
      dataPreserved: boolean
    }>('stopAppService', params)
  }

  deleteApp(params: { userId: string; appId: string }) {
    return this.call<{ appId: string; deleted: true }>('deleteApp', params)
  }

  destroyAppContainer(params: { userId: string; appId: string }) {
    return this.call<{
      appId: string
      userId: string
      state: 'stopped'
      stopReason: StopReason
      dataPreserved: boolean
    }>('destroyAppContainer', params)
  }

  renewAppLease(params: { userId: string; appId: string; days?: number }) {
    return this.call<{
      appId: string
      userId: string
      state: string
      leaseExpiresAt: number
      leaseVersion: number
      weeklyCleanupExempt: boolean
    }>('renewAppLease', params)
  }

  inspectAppStatus(params: { userId: string; appId?: string }) {
    return this.call<AppRuntimeStatus[]>('inspectAppStatus', params, 5000)
  }

  createAppBackup(params: { userId: string; appId: string; note?: string }) {
    return this.call<{
      backupId: string
      appId: string
      createdAt: number
      sizeBytes: number
    }>('createAppBackup', params)
  }

  touchAppActivity(params: { userId: string; appId: string }) {
    return this.call<{ ok: boolean; lastActiveAt: number }>(
      'touchAppActivity',
      params,
      5000,
    )
  }

  reconcileAll() {
    return this.call<{
      reconciledApps: number
      snapshot: ParentResourceSnapshot
    }>('reconcileAll', {})
  }

  getParentResourceSnapshot() {
    return this.call<ParentResourceSnapshot>('getParentResourceSnapshot', {})
  }
}
