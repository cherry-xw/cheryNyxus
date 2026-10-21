import { z } from 'zod'

/**
 * 精确二进制字节常量（严禁混用十进制 MB/GB）
 */
export const MiB = 1024 * 1024
export const GiB = 1024 * 1024 * 1024

export const DEFAULT_RUNTIME_LIMITS = {
  /** 工作组常态总内存上限 2 GiB (用户已确认) */
  parentMemoryNormalMaxBytes: 2 * GiB,
  /** 工作组常态 MemoryHigh 1.75 GiB */
  parentMemoryNormalHighBytes: Math.floor(1.75 * GiB),
  /** 工作组瞬时总内存最高上限 4 GiB (用户已确认) */
  parentMemoryPeakMaxBytes: 4 * GiB,
  /** 单容器常态内存上限 200 MiB (用户已确认) */
  appMemoryNormalMaxBytes: 200 * MiB,
  /** 单容器瞬时构建内存上限 1.5 GiB (建议初值) */
  appMemoryBurstMaxBytes: 1536 * MiB,
  /** 单容器启动初始预留 128 MiB */
  appStartReserveBytes: 128 * MiB,
  /** 每运行容器固定管理开销 24 MiB */
  appMetaOverheadBytes: 24 * MiB,
  /** 常态全局安全余量 256 MiB */
  parentSafetyReserveBytes: 256 * MiB,
  /** 瞬时回落安全水位 170 MiB */
  burstCooldownTargetBytes: 170 * MiB,
  /** 宿主机启动新容器最低 MemAvailable 保护线 2 GiB */
  hostMinMemAvailableNormalBytes: 2 * GiB,
  /** 宿主机启动瞬时构建最低 MemAvailable 保护线 2.5 GiB */
  hostMinMemAvailableBurstBytes: Math.floor(2.5 * GiB),
  /** 宿主机磁盘最低可用空间保护线 5 GiB */
  hostMinDiskAvailableBytes: 5 * GiB,
  /** 父级总 PIDs 上限 512 */
  parentPidsMax: 512,
  /** 单容器 PIDs 上限 128 */
  appPidsMax: 128,
  /** 父级 CPU 配额 2.0 核 */
  parentCpuCores: 2.0,
  /** 单容器常态 CPU 0.5 核 */
  appCpuNormalCores: 0.5,
  /** 单容器构建 CPU 1.0 核 */
  appCpuBurstCores: 1.0,
  /** 单容器文件描述符上限 1024 */
  appNofileLimit: 1024,
  /** 每项目磁盘配额 512 MiB */
  projectDiskQuotaBytes: 512 * MiB,
  /** 每项目 inode 配额 20,000 */
  projectInodeQuota: 20_000,
  /** 命令输出最大截断字节数 256 KiB */
  maxCommandOutputBytes: 256 * 1024,
  /** 普通命令默认超时 60s，最大 180s */
  defaultExecTimeoutSec: 60,
  maxStandardExecTimeoutSec: 180,
  /** 构建命令最大超时 300s */
  maxBuildExecTimeoutSec: 300,
  /** 瞬时队列最大排队数 10，单用户最大排队数 2，排队超时 60s */
  maxBurstQueueLength: 10,
  maxBurstQueuePerUser: 2,
  burstQueueWaitTimeoutMs: 60_000,
  /** 默认空闲自动停止时间 24 小时 */
  defaultIdleTimeoutHours: 24,
  /** 默认初始/单次续期租期 7 天 */
  defaultLeaseDays: 7,
} as const

export type RuntimeLimits = {
  [K in keyof typeof DEFAULT_RUNTIME_LIMITS]: number
}

export const qqRealUserIdSchema = z
  .string()
  .regex(/^[1-9]\d{4,19}$/, '需要已验证的真实个人 QQ 号（5-20 位数字）')

const RESERVED_APP_IDS = new Set([
  'share',
  'api',
  'assets',
  'static',
  'admin',
  'login',
  'logout',
  'ws',
  'events',
  'system',
  'health',
])

export const appIdSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/,
    'appId 须为 3-32 位小写字母、数字或连字符，且不能以连字符开头或结尾',
  )
  .refine(id => !RESERVED_APP_IDS.has(id), 'appId 不能使用系统保留字')

export const relativeCwdSchema = z
  .string()
  .max(256)
  .refine(
    val => {
      if (!val || val === '.') return true
      if (val.startsWith('/') || val.includes('\\') || val.includes('\0')) return false
      const parts = val.split('/')
      return parts.every(p => p.length > 0 && p !== '.' && p !== '..')
    },
    'cwd 必须为 /workspace 内的安全相对路径',
  )

export type AppErrorCode =
  | 'IDENTITY_REQUIRED'
  | 'APP_ACCESS_DENIED'
  | 'APP_NOT_FOUND'
  | 'APP_STOPPED'
  | 'INVALID_INPUT'
  | 'RESOURCE_BUDGET_EXCEEDED'
  | 'BURST_QUEUE_FULL'
  | 'BURST_QUEUE_TIMEOUT'
  | 'DEPENDENCY_NOT_IN_TEMPLATE'
  | 'HEALTHCHECK_FAILED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'HOST_PRESSURE_GUARD'
  | 'CONTROLLER_UNAVAILABLE'
  | 'COMMAND_EXEC_FAILED'

export class ManagedAppError extends Error {
  readonly code: AppErrorCode
  readonly details?: Record<string, unknown>

  constructor(code: AppErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ManagedAppError'
    this.code = code
    this.details = details
  }
}

export type AppContainerState =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'crashed_oom'
  | 'error'

export type BurstPhase =
  | 'normal'
  | 'burst_granted'
  | 'burst_running'
  | 'burst_cleaning'

export type StopReason =
  | 'initial'
  | 'manual_stop'
  | 'idle_timeout'
  | 'lease_expired'
  | 'weekly_cleanup'
  | 'oom_killed'
  | 'host_emergency'
  | 'reconcile_recovered'

export interface ManagedAppRecord {
  userId: string
  appId: string
  projectId: number
  title: string
  description: string
  visibility: 'private' | 'public_read'
  templateVersion: string
  state: AppContainerState
  stopReason: StopReason
  containerName: string
  containerId: string | null
  serviceReady?: boolean
  containerIp: string | null
  createdAt: number
  updatedAt: number
  lastActiveAt: number
  startedAt: number | null
  stoppedAt: number | null
  leaseExpiresAt: number
  leaseVersion: number
  weeklyCleanupExempt: boolean
  adminActivated: boolean
  activationTokenHash: string | null
  activationExpiresAt: number | null
  creatorChannel: {
    channel: 'qq'
    selfId: string
    userId: string
    conversationType: 'private' | 'group'
    groupId?: string
  } | null
}

export interface CommandTaskResult {
  taskId: string
  appId: string
  userId: string
  profile: 'standard' | 'build'
  status: 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled' | 'oom_killed'
  exitCode: number | null
  durationMs: number
  stdout: string
  stderr: string
  truncated: boolean
  startedAt: number
  finishedAt: number | null
}

/** Local controller transport only; original bytes precede the truncated tool preview. */
export type ControllerCommandOutput = (stream: 'stdout' | 'stderr', chunk: Buffer) => void
export const ControllerOutputFrameSchema = z.object({
  id: z.string().min(1), type: z.literal('command-output'), stream: z.enum(['stdout', 'stderr']),
  dataBase64: z.string().max(88_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
}).strict()

export interface AppRuntimeStatus {
  userId: string
  appId: string
  title: string
  description: string
  state: AppContainerState
  stopReason: StopReason
  appUrl: string
  serviceReady?: boolean
  containerIp: string | null
  memoryCurrentBytes: number
  memoryLimitBytes: number
  diskUsedBytes: number
  diskLimitBytes: number
  inodesUsed: number
  inodesLimit: number
  createdAt: number
  lastActiveAt: number
  startedAt: number | null
  leaseExpiresAt: number
  leaseVersion: number
  weeklyCleanupExempt: boolean
}

export interface ParentResourceSnapshot {
  burstPhase: BurstPhase
  activeBurstAppKey: string | null
  parentMemoryCurrentBytes: number
  parentMemoryMaxBytes: number
  parentPidsCurrent: number
  parentPidsMax: number
  hostMemAvailableBytes: number
  hostDiskAvailableBytes: number
  runningContainerCount: number
  startingContainerCount: number
  effectiveNormalCommittedBytes: number
}

export const controllerRpcRequestSchema = z.discriminatedUnion('method', [
  z.object({ id: z.string(), method: z.literal('claimAppNotifications'), params: z.object({ selfId: qqRealUserIdSchema }) }),
  z.object({ id: z.string(), method: z.literal('reportAppNotification'), params: z.object({ selfId: qqRealUserIdSchema, notificationId: z.string().max(150), status: z.enum(['sent', 'failed', 'unknown']) }) }),
  z.object({
    id: z.string(),
    method: z.literal('ensureAppWorkspace'),
    params: z.object({
      userId: qqRealUserIdSchema,
      appId: appIdSchema,
      title: z.string().min(1).max(80),
      description: z.string().max(500).optional(),
      visibility: z.enum(['private', 'public_read']).optional(),
      creatorChannel: z
        .object({
          channel: z.literal('qq'),
          selfId: z.string(),
          userId: z.string(),
          conversationType: z.enum(['private', 'group']),
          groupId: z.string().optional(),
        })
        .optional(),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal('runAppCommand'),
    params: z.object({
      userId: qqRealUserIdSchema,
      appId: appIdSchema,
      command: z.string().min(1).max(16_384),
      taskId: z.string().regex(/^task_[a-f0-9]{16}$/).optional(),
      cwd: relativeCwdSchema.optional(),
      profile: z.enum(['standard', 'build']).optional(),
      timeoutSec: z.number().int().min(1).max(300).optional(),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal('getTaskStatus'),
    params: z.object({
      userId: qqRealUserIdSchema,
      appId: appIdSchema,
      taskId: z.string().min(1).max(64),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal('cancelAppCommand'),
    params: z.object({
      userId: qqRealUserIdSchema,
      appId: appIdSchema,
      taskId: z.string().min(1).max(64),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal('startAppService'),
    params: z.object({
      userId: qqRealUserIdSchema,
      appId: appIdSchema,
      buildFirst: z.boolean().optional(),
      taskId: z.string().regex(/^task_[a-f0-9]{16}$/).optional(),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal('stopAppService'),
    params: z.object({
      userId: qqRealUserIdSchema,
      appId: appIdSchema,
      reason: z
        .enum([
          'manual_stop',
          'idle_timeout',
          'lease_expired',
          'weekly_cleanup',
          'host_emergency',
        ])
        .optional(),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal('deleteApp'),
    params: z.object({ userId: qqRealUserIdSchema, appId: appIdSchema }).strict(),
  }),
  z.object({
    id: z.string(),
    method: z.literal('destroyAppContainer'),
    params: z.object({
      userId: qqRealUserIdSchema,
      appId: appIdSchema,
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal('renewAppLease'),
    params: z.object({
      userId: qqRealUserIdSchema,
      appId: appIdSchema,
      days: z.number().int().min(1).max(7).optional(),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal('inspectAppStatus'),
    params: z.object({
      userId: qqRealUserIdSchema,
      appId: appIdSchema.optional(),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal('createAppBackup'),
    params: z.object({
      userId: qqRealUserIdSchema,
      appId: appIdSchema,
      note: z.string().max(200).optional(),
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal('touchAppActivity'),
    params: z.object({
      userId: qqRealUserIdSchema,
      appId: appIdSchema,
    }),
  }),
  z.object({
    id: z.string(),
    method: z.literal('reconcileAll'),
    params: z.object({}).optional(),
  }),
  z.object({
    id: z.string(),
    method: z.literal('getParentResourceSnapshot'),
    params: z.object({}).optional(),
  }),
])

export type ControllerRpcRequest = z.infer<typeof controllerRpcRequestSchema>

export interface ControllerRpcSuccess<T = unknown> {
  id: string
  ok: true
  result: T
}

export interface ControllerRpcFailure {
  id: string
  ok: false
  error: {
    code: AppErrorCode
    message: string
    details?: Record<string, unknown>
  }
}

export type ControllerRpcResponse<T = unknown> =
  | ControllerRpcSuccess<T>
  | ControllerRpcFailure
