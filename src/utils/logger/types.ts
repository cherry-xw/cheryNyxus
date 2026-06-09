/**
 * Logger 模块统一类型定义
 */
import type { LoggerConfig as ConfigLoggerConfig } from "@/utils/config.js";

// ============================================================================
// 日志等级
// ============================================================================

/**
 * 日志等级枚举
 */
export enum LogLevel {
  debug = 0,
  info = 1,
  warn = 2,
  error = 3,
  silent = 4,
}

// ============================================================================
// Logger 类型
// ============================================================================

/**
 * 内部解析后的 Logger 配置
 */
export interface InternalLoggerConfig {
  level: LogLevel;
  output: ("console" | "file")[];
  timestamp: boolean;
  location: boolean;
  format: "plain" | "json";
}

/**
 * 日志工具函数集合
 */
export interface LoggerTools {
  // Bash 日志
  getBashLogDir(): string;
  createBashLogPath(pid: number, startTime: number): string;
  formatBashLogHeader(info: BashLogInfo): string;
  cleanOldBashLogs(retentionHours: number): void;

  // 通用文件日志
  getLogDirectory(name: string): string;
  createLogFilePath(logDirName: string, filename: string): string;
  getLogSize(logPath: string): number;
  shouldShowPartialLog(logPath: string): boolean;
  getLogSizeThreshold(): number;
  formatLogSize(bytes: number): string;
  createLogStream(logPath: string): import("fs").WriteStream;
  cleanOldLogFiles(logDirName: string, retentionHours: number): void;
}

/**
 * Logger 公共接口
 */
export interface Logger {
  debug(...args: unknown[]): void;
  info(...args: unknown[]): void;
  write(message: string): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  close(): void;
  getConfig(): InternalLoggerConfig;
  setConfig(config: Partial<ConfigLoggerConfig>): void;
  tools: LoggerTools;
}

// ============================================================================
// Bash 日志类型
// ============================================================================

/**
 * Bash 日志信息
 */
export interface BashLogInfo {
  pid: number;
  command: string;
  startTime: number;
  logPath: string;
  description?: string;
  status: "running" | "completed" | "killed";
}
