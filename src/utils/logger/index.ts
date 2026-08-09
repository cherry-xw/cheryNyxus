/**
 * 统一日志模块 —— 结构化事件 trace
 *
 * - 全项目唯一日志出口。每条日志 = 一个 JSON 事件（单行），带 LogScope 关联键。
 * - AsyncLocalStorage 承载 scope，沿 async 链自动传播；边界（router / Middleware / ws）用 run() 注入。
 * - 解释模块按 traceId（chatId）过滤事件流，还原用户每一步操作。
 *
 * 配置来自 .chery/config.yaml 的 global.logger（utils/config.ts LoggerConfig）。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createWriteStream, mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import dayjs from 'dayjs'
import type { WriteStream } from 'fs'
import type { LoggerConfig as ConfigLoggerConfig } from '@/utils/config.js'
import { LogLevel } from './types.js'
import type { InternalLoggerConfig, LogEvent, LogScope, Logger, BashLogInfo } from './types.js'

// Re-export externally used types
export type { BashLogInfo, LogScope, LogEvent, Logger } from './types.js'
export { LogLevel } from './types.js'

// ============================================================================
// 配置解析
// ============================================================================

function parseLogLevel(level?: string): LogLevel {
  if (!level) return LogLevel.info
  const levels: Record<string, LogLevel> = {
    debug: LogLevel.debug,
    info: LogLevel.info,
    warn: LogLevel.warn,
    error: LogLevel.error,
    silent: LogLevel.silent,
  }
  return levels[level.toLowerCase()] ?? LogLevel.info
}

/**
 * 从全局配置加载 Logger 配置
 * 注意：此函数在 config.ts 加载后被调用
 */
function loadLoggerConfig(globalLoggerConfig?: ConfigLoggerConfig): InternalLoggerConfig {
  return {
    level: parseLogLevel(globalLoggerConfig?.level),
    output: globalLoggerConfig?.output ?? ['console'],
    timestamp: globalLoggerConfig?.timestamp ?? true,
    location: globalLoggerConfig?.location ?? true,
    format: globalLoggerConfig?.format ?? 'json',
  }
}

// ============================================================================
// ALS scope 引擎（全局单例 —— 跨 createLogger 实例共享，保证 run/getScope 一致）
// ============================================================================

const scopeAls = new AsyncLocalStorage<LogScope>()

/** 去除 undefined 字段，避免 scope 对象噪音 */
function cleanScope(scope: Partial<LogScope>): LogScope {
  const out: LogScope = {}
  for (const [k, v] of Object.entries(scope)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/**
 * 注入 scope 并执行 fn。与父 scope 合并（子层覆盖同名键）。
 * 用于边界（router / Middleware.send / ws connection）建立请求/会话作用域。
 */
function runScope<T>(scope: Partial<LogScope>, fn: () => T): T {
  const parent = scopeAls.getStore()
  const merged = cleanScope({ ...(parent ?? {}), ...scope })
  return scopeAls.run(merged, fn)
}

function getScope(): LogScope {
  return scopeAls.getStore() ?? {}
}

/**
 * Prevent credentials from crossing the logging boundary.  This is applied in
 * one place so structured events, legacy logger calls, and config baselines
 * all receive the same protection.
 */
const SENSITIVE_FIELD = /(key|token|secret|password|authorization|credential|env)/i

function redactLogData(value: unknown, fieldName?: string, seen = new WeakSet<object>()): unknown {
  if (fieldName && SENSITIVE_FIELD.test(fieldName)) return '[REDACTED]'
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return '[CIRCULAR]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((item) => redactLogData(item, undefined, seen))
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      redactLogData(item, key, seen),
    ]),
  )
}

// ============================================================================
// Logger 工厂函数（闭包式，替代 class）
// ============================================================================

function createLogger(config?: ConfigLoggerConfig): Logger {
  let _config = loadLoggerConfig(config)
  let _fileStream: WriteStream | undefined

  function initFileStream(): void {
    const cheryDir = process.env.CHERY_DIR || process.cwd()
    const logDir = join(cheryDir, '.chery', 'logs')

    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true })
    }

    const logFile = join(logDir, `${dayjs().format('YYYY-MM-DD')}.log`)
    const isNewFile = !existsSync(logFile)
    _fileStream = createWriteStream(logFile, { flags: 'a' })

    // 新日志文件时标记需要记录基准配置（由外部调用 recordConfigBaseline）
    if (isNewFile) {
      _needsConfigBaseline = true
    }
  }

  /** 标记：新日志文件需要记录基准配置 */
  let _needsConfigBaseline = false

  /** 记录配置基准（日志文件新建时调用，避免循环依赖） */
  function recordConfigBaseline(configData: object): void {
    if (_needsConfigBaseline && _fileStream) {
      emit(
        'config.baseline',
        { config: configData as Record<string, unknown> },
        LogLevel.info,
        'info',
      )
      _needsConfigBaseline = false
    }
  }

  if (_config.output.includes('file')) {
    initFileStream()
  }

  function getLocation(): string {
    const stack = new Error().stack?.split('\n') || []
    for (const line of stack) {
      // 跳过 logger 模块内部栈帧
      if (line.includes('utils/logger')) continue
      const match = line.match(/at\s+(?:.*?\s+\()?(.+):(\d+):(\d+)\)?/)
      if (match && match[1]) {
        const file = match[1].split('/').pop() ?? match[1]
        return `${file}:${match[2]}`
      }
    }
    return 'unknown'
  }

  /** 序列化任意参数为字符串（用于 legacy info/warn/error 的 message 字段） */
  function formatArgs(args: unknown[]): string {
    return args
      .map((arg) => {
        if (typeof arg === 'string') return arg
        if (arg instanceof Error) return arg.stack ?? arg.message
        try {
          return JSON.stringify(arg)
        } catch {
          return String(arg)
        }
      })
      .join(' ')
  }

  function renderPlain(e: LogEvent): string {
    const parts: string[] = []
    if (_config.timestamp) parts.push(e.ts)
    const scopeTag = formatScopeTag(e.scope)
    if (scopeTag) parts.push(scopeTag)
    if (e.location) parts.push(`[${e.location}]`)
    parts.push(`[${e.level}]`)
    parts.push(e.type)
    if (e.data && e.data['message'] !== undefined) {
      parts.push(String(e.data['message']))
    } else if (e.data) {
      parts.push(JSON.stringify(e.data))
    }
    return parts.join(' ')
  }

  /** plain 格式下 scope → `[traceId=… runId=…]`（仅非空字段，固定顺序） */
  function formatScopeTag(scope: LogScope): string {
    const order: (keyof LogScope)[] = ['traceId', 'requestId', 'runId', 'connectionId', 'spanId']
    const segs = order.filter((k) => scope[k] !== undefined).map((k) => `${k}=${scope[k]}`)
    return segs.length ? `[${segs.join(' ')}]` : ''
  }

  function emit(
    type: string,
    data: Record<string, unknown> | undefined,
    level: LogLevel,
    levelName: string,
  ): void {
    if (_config.level > level) return

    const scope = getScope()
    const event: LogEvent = {
      // 时间戳去掉年月日（日志文件名已按天分割），保留时分秒毫秒时区
      // 例如：T13:45:30.123Z（从 2026-07-10T13:45:30.123Z 切掉前10位）
      ts: new Date().toISOString().slice(11),
      level: levelName,
      type,
      scope,
    }
    if (_config.location) event.location = getLocation()
    if (data && Object.keys(data).length > 0) {
      event.data = redactLogData(data) as Record<string, unknown>
    }

    const line = _config.format === 'json' ? JSON.stringify(event) : renderPlain(event)

    if (_config.output.includes('console')) {
      const stream = level >= LogLevel.error ? process.stderr : process.stdout
      stream.write(line + '\n')
    }
    if (_fileStream) {
      _fileStream.write(line + '\n')
    }
  }

  function event(
    type: string,
    data?: Record<string, unknown>,
    level: LogLevel = LogLevel.info,
  ): void {
    const levelName = levelNameOf(level)
    emit(type, data, level, levelName)
  }

  function levelNameOf(level: LogLevel): string {
    switch (level) {
      case LogLevel.debug:
        return 'debug'
      case LogLevel.info:
        return 'info'
      case LogLevel.warn:
        return 'warn'
      case LogLevel.error:
        return 'error'
      default:
        return 'info'
    }
  }

  return {
    event,
    run: runScope,
    getScope,
    debug(...args: unknown[]) {
      emit('log.debug', { message: formatArgs(args) }, LogLevel.debug, 'debug')
    },
    info(...args: unknown[]) {
      emit('log.info', { message: formatArgs(args) }, LogLevel.info, 'info')
    },
    warn(...args: unknown[]) {
      emit('log.warn', { message: formatArgs(args) }, LogLevel.warn, 'warn')
    },
    error(...args: unknown[]) {
      emit('log.error', { message: formatArgs(args) }, LogLevel.error, 'error')
    },
    close() {
      _fileStream?.end()
    },
    getConfig() {
      return _config
    },
    setConfig(config: Partial<ConfigLoggerConfig>) {
      _config = { ..._config, ...loadLoggerConfig(config) }
      if (config.output && !_fileStream && config.output.includes('file')) {
        initFileStream()
      }
    },
    recordConfigBaseline,
    tools: {
      getBashLogDir,
      createBashLogPath,
      formatBashLogHeader,
      cleanOldBashLogs,
      getLogDirectory,
      createLogFilePath,
      getLogSize,
      shouldShowPartialLog,
      getLogSizeThreshold,
      formatLogSize,
      createLogStream,
      cleanOldLogFiles,
    },
  }
}

// ============================================================================
// 默认实例（延迟初始化）
// ============================================================================

let _logger: Logger | null = null

/**
 * 初始化默认 Logger（由 config.ts 调用）
 */
export function initLogger(config?: ConfigLoggerConfig): Logger {
  _logger = createLogger(config)
  return _logger
}

/**
 * 获取默认 Logger 实例
 */
function getLogger(): Logger {
  if (!_logger) {
    _logger = createLogger()
  }
  return _logger
}

/** 默认 Logger 代理（延迟初始化，自动转发所有属性访问） */
export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop: string | symbol) {
    return Reflect.get(getLogger(), prop)
  },
})

// ============================================================================
// Bash 日志工具（内部函数，通过 logger.tools 暴露）
// ============================================================================

const BASH_LOG_DIR_NAME = 'CheryNyxus-bash-logs'

function getBashLogDir(): string {
  return getLogDirectory(BASH_LOG_DIR_NAME)
}

function createBashLogPath(pid: number, startTime: number): string {
  return createLogFilePath(BASH_LOG_DIR_NAME, `${startTime}-${pid}.log`)
}

function formatBashLogHeader(info: BashLogInfo): string {
  const startTimeStr = new Date(info.startTime).toLocaleString('zh-CN', {
    hour12: false,
  })

  let header = `---
PID: ${info.pid}
Command: ${info.command}
StartTime: ${startTimeStr}
Status: ${info.status}
`

  if (info.description) {
    header += `Description: ${info.description}\n`
  }

  header += `---\n`
  return header
}

function cleanOldBashLogs(retentionHours: number): void {
  cleanOldLogFiles(BASH_LOG_DIR_NAME, retentionHours)
}

// ============================================================================
// 文件日志工具（内部函数，通过 logger.tools 暴露）
// ============================================================================

const LOG_SIZE_THRESHOLD = 10 * 1024

const logDirCache = new Map<string, string>()

function getLogDirectory(name: string): string {
  const cached = logDirCache.get(name)
  if (cached) return cached

  const dir = join(tmpdir(), name)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  logDirCache.set(name, dir)
  return dir
}

function createLogFilePath(logDirName: string, filename: string): string {
  return join(getLogDirectory(logDirName), filename)
}

function getLogSize(logPath: string): number {
  try {
    return statSync(logPath).size
  } catch {
    return 0
  }
}

function shouldShowPartialLog(logPath: string): boolean {
  return getLogSize(logPath) > LOG_SIZE_THRESHOLD
}

function getLogSizeThreshold(): number {
  return LOG_SIZE_THRESHOLD
}

function formatLogSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)}KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
}

function createLogStream(logPath: string): WriteStream {
  return createWriteStream(logPath, { flags: 'w' })
}

function cleanOldLogFiles(logDirName: string, retentionHours: number): void {
  const dir = getLogDirectory(logDirName)
  if (!existsSync(dir)) return

  const now = Date.now()
  const retentionMs = retentionHours * 60 * 60 * 1000

  const files = readdirSync(dir)
  for (const file of files) {
    if (!file.endsWith('.log')) continue

    const filePath = join(dir, file)
    try {
      const stats = statSync(filePath)
      if (now - stats.birthtimeMs > retentionMs) {
        unlinkSync(filePath)
      }
    } catch {
      // ignore files removed by another process
    }
  }
}
