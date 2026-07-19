/**
 * Logger 模块统一类型定义
 *
 * 结构化事件 trace 日志：
 * - ALS（AsyncLocalStorage）承载 LogScope，沿 async 链自动传播；
 * - 输出为单行 JSON 事件流（机器可解析），解释模块按 traceId 还原会话流程。
 */
import type { LoggerConfig as ConfigLoggerConfig } from '@/utils/config.js'

// ============================================================================
// 日志等级
// ============================================================================

export enum LogLevel {
  debug = 0,
  info = 1,
  warn = 2,
  error = 3,
  silent = 4,
}

// ============================================================================
// Scope（会话关联）
// ============================================================================

/**
 * 日志作用域 —— 每条事件携带的关联键。
 * 经 ALS 沿 async 链传播；run() 与父 scope 合并（子层覆盖同名键）。
 */
export interface LogScope {
  /** 会话 traceId（= chatId，跨轮稳定） */
  traceId?: string
  /** 单次 RPC 请求 */
  requestId?: string
  /** WebSocket 连接 */
  connectionId?: string
  /** 单次 chain 执行（per send/resume） */
  runId?: string
  /** 嵌套 span（senseCall / llm call） */
  spanId?: string
  parentSpanId?: string
}

// ============================================================================
// Logger 类型
// ============================================================================

export interface InternalLoggerConfig {
  level: LogLevel
  output: ('console' | 'file')[]
  timestamp: boolean
  location: boolean
  format: 'plain' | 'json'
}

/**
 * 结构化事件（JSON 行）
 */
export interface LogEvent {
  ts: string
  level: string
  type: string
  scope: LogScope
  location?: string
  data?: Record<string, unknown>
}

/**
 * 日志工具函数集合（bash 子进程 + 通用文件日志，供 execute_command 等感官消费）
 */
export interface LoggerTools {
  // Bash 日志
  getBashLogDir(): string
  createBashLogPath(pid: number, startTime: number): string
  formatBashLogHeader(info: BashLogInfo): string
  cleanOldBashLogs(retentionHours: number): void

  // 通用文件日志
  getLogDirectory(name: string): string
  createLogFilePath(logDirName: string, filename: string): string
  getLogSize(logPath: string): number
  shouldShowPartialLog(logPath: string): boolean
  getLogSizeThreshold(): number
  formatLogSize(bytes: number): string
  createLogStream(logPath: string): import('fs').WriteStream
  cleanOldLogFiles(logDirName: string, retentionHours: number): void
}

/**
 * Logger 公共接口
 */
export interface Logger {
  /** 结构化事件发射（主接口） */
  event(type: string, data?: Record<string, unknown>, level?: LogLevel): void
  /** 边界注入 scope（与父 scope 合并），执行 fn */
  run<T>(scope: Partial<LogScope>, fn: () => T): T
  /** 读取当前 ALS scope（无则空对象） */
  getScope(): LogScope

  /**
   * 兜底方法（未迁移调用点 / 简易诊断用）：转 event(type=`log.<level>`, {message})。
   * 新代码应直接用 event()。
   */
  debug(...args: unknown[]): void
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void

  close(): void
  getConfig(): InternalLoggerConfig
  setConfig(config: Partial<ConfigLoggerConfig>): void
  /** 记录配置基准（日志文件新建时调用，避免循环依赖） */
  recordConfigBaseline(configData: object): void
  tools: LoggerTools
}

// ============================================================================
// Bash 日志类型
// ============================================================================

export interface BashLogInfo {
  pid: number
  command: string
  startTime: number
  logPath: string
  description?: string
  status: 'running' | 'completed' | 'killed'
}
