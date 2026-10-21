import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { sense, type SenseRuntimeContext } from '@/core/sense/senseCreator.js'
import { SupervisionLevel } from '@/core/config.js'
import { ControllerSocketClient } from '@/service/managedApp/socketRpc.js'
import { appIdSchema, qqRealUserIdSchema, relativeCwdSchema, ManagedAppError } from '@/service/managedApp/types.js'
import { runManagedCommand } from '@/service/managedCommands.js'

export const managedAppSchema = z.object({
  action: z.enum(['create', 'exec', 'task_status', 'task_cancel', 'publish', 'stop', 'delete', 'renew', 'status', 'backup']),
  appId: appIdSchema.optional(),
  title: z.string().min(1).max(80).optional(),
  description: z.string().max(500).optional(),
  visibility: z.enum(['private', 'public_read']).optional(),
  command: z.string().min(1).max(16_384).optional(),
  cwd: relativeCwdSchema.optional(),
  profile: z.enum(['standard', 'build']).optional(),
  timeoutSec: z.number().int().min(1).max(300).optional(),
  taskId: z.string().regex(/^task_[a-f0-9]{16}$/).optional(),
  buildFirst: z.boolean().optional(),
  days: z.number().int().min(1).max(7).optional(),
  note: z.string().max(200).optional(),
}).strict()

export function managedAppPrincipal(ctx?: SenseRuntimeContext) {
  const identity = ctx?.requestView?.identity
  const subject = identity?.subject
  if (identity?.source !== 'plugin' || identity.channel !== 'qq' || !subject ||
      !qqRealUserIdSchema.safeParse(subject.userId).success ||
      !qqRealUserIdSchema.safeParse(subject.selfId).success ||
      !['private', 'group'].includes(subject.conversationType) ||
      (subject.conversationType === 'group' && !qqRealUserIdSchema.safeParse(subject.groupId).success) ||
      (subject.conversationType === 'private' && subject.groupId !== undefined)) {
    throw new ManagedAppError('IDENTITY_REQUIRED', '需要已验证的真实 QQ 个人号码；插件包 ID、OpenID 和模型参数不能作为用户身份')
  }
  return { userId: subject.userId, creatorChannel: { channel: 'qq' as const, ...subject } }
}

/** Strip controller-only fields before inserting observations into model context. */
function publicResult(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(publicResult)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['userId', 'ownerId', 'containerIp', 'containerId', 'containerName', 'projectId', 'creatorChannel'].includes(key)
  ).map(([key, item]) => [key, publicResult(item)]))
}

export function createManagedAppSense(client = new ControllerSocketClient()) {
  return sense('managed_app',
    '管理当前用户的小应用。create 必须同时提供 appId（3-32 位小写字母/数字/连字符，首尾不能为连字符）和 title；后续动作复用同一 appId。create 创建固定模板；exec 在所属工作容器 /workspace 执行命令（可用 Node 标准库读写项目文件）；publish 离线构建并启动；status 查询；stop 停止且保留数据；delete 仅在用户明确要求彻底删除时清除本人指定应用的代码、数据、备份、容器和登记，不得因失败自动删除；renew 续期；backup 备份；task_status/task_cancel 管理任务。不得传 userId、宿主路径、容器参数。只有 publish 返回健康通过才表示应用启动，公网访问另需网关部署。激活链接仅私聊交付，勿发到群聊。',
    managedAppSchema, async (raw, _shared, ctx) => {
      try {
        const input = managedAppSchema.parse(raw)
        ctx?.signal?.throwIfAborted()
        const principal = managedAppPrincipal(ctx)
        const { action } = input
        if (action !== 'status' && !input.appId) throw new ManagedAppError('INVALID_INPUT', `${action} 必须提供 appId（3-32 位小写字母、数字或连字符，首尾不能为连字符）；create 示例：{"action":"create","appId":"vue-hello-service","title":"Vue Hello World"}。补齐参数后可重新调用，无需申请额外权限。`)
        const owned = { userId: principal.userId, appId: input.appId! }
        let result: unknown
        switch (action) {
          case 'delete':
            result = await client.deleteApp(owned)
            break
          case 'create':
            if (!input.title) throw new ManagedAppError('INVALID_INPUT', 'create 必须提供 title')
            result = await client.ensureAppWorkspace({ ...owned, title: input.title, description: input.description, visibility: input.visibility, creatorChannel: principal.creatorChannel })
            break
          case 'exec':
            if (!input.command) throw new ManagedAppError('INVALID_INPUT', 'exec 必须提供 command')
            {
              const taskId = `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`
              result = await runManagedCommand({ client, context: ctx, task: { ...owned, taskId },
                sourceKind: 'managed_exec', command: input.command, workdir: input.cwd,
                execute: (output) => client.runAppCommand({ ...owned, taskId, command: input.command!, cwd: input.cwd,
                  profile: input.profile, timeoutSec: Math.min(input.timeoutSec ?? 60, input.profile === 'build' ? 300 : 180) }, output),
                evidence: (value) => value,
              })
              ctx?.signal?.throwIfAborted()
            }
            break
          case 'task_status':
          case 'task_cancel':
            if (!input.taskId) throw new ManagedAppError('INVALID_INPUT', '任务操作必须提供 taskId')
            result = action === 'task_status' ? await client.getTaskStatus({ ...owned, taskId: input.taskId }) : await client.cancelAppCommand({ ...owned, taskId: input.taskId })
            break
          case 'publish': {
            const taskId = `task_${randomUUID().replace(/-/g, '').slice(0, 16)}`
            result = await runManagedCommand({ client, context: ctx, task: { ...owned, taskId },
              sourceKind: 'managed_publish', command: input.buildFirst === false ? 'publish: start' : 'publish: build and start',
              execute: (output) => client.startAppService({ ...owned, taskId, buildFirst: input.buildFirst }, output),
              evidence: () => ({ status: 'completed', exitCode: 0 }),
            })
            ctx?.signal?.throwIfAborted()
            break
          }
          case 'stop': result = await client.stopAppService(owned); break
          case 'renew': result = await client.renewAppLease({ ...owned, days: input.days }); break
          case 'status': result = await client.inspectAppStatus({ userId: principal.userId, appId: input.appId }); break
          case 'backup': result = await client.createAppBackup({ ...owned, note: input.note }); break
        }
        const output = publicResult(result) as Record<string, unknown>
        if (principal.creatorChannel.conversationType === 'group' && output && !Array.isArray(output)) delete output.activationUrl
        return { content: JSON.stringify({ ok: true, result: output }),
          ...(output?.status === 'cancelled' ? { status: 'cancelled' as const, errorCode: 'cancelled' as const } : {}) }
      } catch (error) {
        if ((error as { managedCommandCancelled?: boolean })?.managedCommandCancelled)
          return { content: '该命令已取消；所属 Agent 任务可以继续。', status: 'cancelled' as const, errorCode: 'cancelled' as const }
        if (ctx?.signal?.aborted && !(error instanceof ManagedAppError)) return { content: '', status: 'cancelled' as const, errorCode: 'cancelled' as const }
        const code = error instanceof ManagedAppError ? error.code : 'INVALID_INPUT'
        return { content: JSON.stringify({ ok: false, error: { code, message: error instanceof ManagedAppError ? error.message : '参数无效或操作未完成' } }), status: 'provider_error' as const, errorCode: 'provider_error' as const }
      }
    }, SupervisionLevel.auto)
}

export default createManagedAppSense()
