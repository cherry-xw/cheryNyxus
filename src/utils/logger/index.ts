/**
 * 统一日志模块
 * 支持日志等级、文件输出、位置追踪、时间戳
 * 配置从 .chery/config.yaml 读取
 */
import {
  createWriteStream,
  mkdirSync,
  existsSync,
  statSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import dayjs from "dayjs";
import type { WriteStream } from "fs";
import type { LoggerConfig as ConfigLoggerConfig } from "@/utils/config.js";
import { LogLevel } from "./types.js";
import type {
  InternalLoggerConfig,
  Logger,
  LoggerTools,
  BashLogInfo,
} from "./types.js";

// Re-export externally used types
export type { BashLogInfo } from "./types.js";
// ============================================================================
// 配置解析
// ============================================================================

function parseLogLevel(level?: string): LogLevel {
  if (!level) return LogLevel.info;
  const levels: Record<string, LogLevel> = {
    debug: LogLevel.debug,
    info: LogLevel.info,
    warn: LogLevel.warn,
    error: LogLevel.error,
    silent: LogLevel.silent,
  };
  return levels[level.toLowerCase()] ?? LogLevel.info;
}

/**
 * 从全局配置加载 Logger 配置
 * 注意：此函数在 config.ts 加载后被调用
 */
function loadLoggerConfig(
  globalLoggerConfig?: ConfigLoggerConfig,
): InternalLoggerConfig {
  return {
    level: parseLogLevel(globalLoggerConfig?.level),
    output: globalLoggerConfig?.output ?? ["console"],
    timestamp: globalLoggerConfig?.timestamp ?? true,
    location: globalLoggerConfig?.location ?? true,
    format: globalLoggerConfig?.format ?? "plain",
  };
}

// ============================================================================
// Logger 工厂函数（闭包式，替代 class）
// ============================================================================

/**
 * 创建 Logger 实例
 * 使用闭包封装状态，返回 Logger 接口对象
 */
function createLogger(config?: ConfigLoggerConfig): Logger {
  let _config = loadLoggerConfig(config);
  let _fileStream: WriteStream | undefined;

  function initFileStream(): void {
    const cheryDir = process.env.CHERY_DIR || process.cwd();
    const logDir = join(cheryDir, ".chery", "logs");

    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }

    const logFile = join(logDir, `${dayjs().format("YYYY-MM-DD")}.log`);
    _fileStream = createWriteStream(logFile, { flags: "a" });
  }

  if (_config.output.includes("file")) {
    initFileStream();
  }

  function getLocation(): string {
    const stack = new Error().stack?.split("\n") || [];
    for (const line of stack) {
      // 跳过 logger 模块内部栈帧
      if (line.includes("utils/logger")) continue;
      const match = line.match(
        /at\s+(?:.*?\s+\()?(.+):(\d+):(\d+)\)?/,
      );
      if (match && match[1]) {
        const file = match[1].split("/").pop() ?? match[1];
        return `${file}:${match[2]}`;
      }
    }
    return "unknown";
  }

  function format(level: string, args: unknown[]): string {
    const message = args
      .map((arg) => {
        if (typeof arg === "string") return arg;
        if (arg instanceof Error) return arg.stack ?? arg.message;
        try {
          return JSON.stringify(arg, null, 2);
        } catch {
          return String(arg);
        }
      })
      .join(" ");

    if (_config.format === "json") {
      const entry = {
        level,
        timestamp: dayjs().format("YYYY-MM-DD HH:mm:ss"),
        location: _config.location ? getLocation() : undefined,
        message,
      };
      return JSON.stringify(entry);
    }

    // plain 格式
    const parts: string[] = [];
    if (_config.timestamp) {
      parts.push(dayjs().format("YYYY-MM-DD HH:mm:ss"));
    }
    if (_config.location) {
      parts.push(`[${getLocation()}]`);
    }
    parts.push(`[${level}]`);
    parts.push(message);
    return parts.join(" ");
  }

  function output(level: LogLevel, levelName: string, args: unknown[]): void {
    if (_config.level > level) return;

    const formatted = format(levelName, args);

    if (_config.output.includes("console")) {
      const stream = level >= LogLevel.error ? process.stderr : process.stdout;
      stream.write(formatted + "\n");
    }

    if (_fileStream) {
      _fileStream.write(formatted + "\n");
    }
  }

  return {
    debug(...args: unknown[]) {
      output(LogLevel.debug, "DEBUG", args);
    },
    info(...args: unknown[]) {
      output(LogLevel.info, "INFO", args);
    },
    write(message: string) {
      if (_config.level > LogLevel.info) return;
      if (_config.output.includes("console")) {
        process.stdout.write(message);
      }
      if (_fileStream) {
        _fileStream.write(message);
      }
    },
    warn(...args: unknown[]) {
      output(LogLevel.warn, "WARN", args);
    },
    error(...args: unknown[]) {
      output(LogLevel.error, "ERROR", args);
    },
    close() {
      _fileStream?.end();
    },
    getConfig() {
      return _config;
    },
    setConfig(config: Partial<ConfigLoggerConfig>) {
      _config = { ..._config, ...loadLoggerConfig(config) };
      if (config.output && !_fileStream && config.output.includes("file")) {
        initFileStream();
      }
    },
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
  };
}

// ============================================================================
// 默认实例（延迟初始化）
// ============================================================================

let _logger: Logger | null = null;

/**
 * 初始化默认 Logger（由 config.ts 调用）
 */
export function initLogger(config?: ConfigLoggerConfig): Logger {
  _logger = createLogger(config);
  return _logger;
}

/**
 * 获取默认 Logger 实例
 */
function getLogger(): Logger {
  if (!_logger) {
    _logger = createLogger();
  }
  return _logger;
}

/** 默认 Logger 代理（延迟初始化，自动转发所有属性访问） */
export const logger: Logger = new Proxy({} as Logger, {
  get(_target, prop: string | symbol) {
    return Reflect.get(getLogger(), prop);
  },
});

// ============================================================================
// Bash 日志工具（内部函数，通过 logger.tools 暴露）
// ============================================================================

const BASH_LOG_DIR_NAME = "cheryClaw-bash-logs";

function getBashLogDir(): string {
  return getLogDirectory(BASH_LOG_DIR_NAME);
}

function createBashLogPath(pid: number, startTime: number): string {
  return createLogFilePath(BASH_LOG_DIR_NAME, `${startTime}-${pid}.log`);
}

function formatBashLogHeader(info: BashLogInfo): string {
  const startTimeStr = new Date(info.startTime).toLocaleString("zh-CN", {
    hour12: false,
  });

  let header = `---
PID: ${info.pid}
Command: ${info.command}
StartTime: ${startTimeStr}
Status: ${info.status}
`;

  if (info.description) {
    header += `Description: ${info.description}\n`;
  }

  header += `---\n`;
  return header;
}

function cleanOldBashLogs(retentionHours: number): void {
  cleanOldLogFiles(BASH_LOG_DIR_NAME, retentionHours);
}

// ============================================================================
// 文件日志工具（内部函数，通过 logger.tools 暴露）
// ============================================================================

const LOG_SIZE_THRESHOLD = 10 * 1024;

const logDirCache = new Map<string, string>();

function getLogDirectory(name: string): string {
  const cached = logDirCache.get(name);
  if (cached) return cached;

  const dir = join(tmpdir(), name);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  logDirCache.set(name, dir);
  return dir;
}

function createLogFilePath(
  logDirName: string,
  filename: string,
): string {
  return join(getLogDirectory(logDirName), filename);
}

function getLogSize(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

function shouldShowPartialLog(logPath: string): boolean {
  return getLogSize(logPath) > LOG_SIZE_THRESHOLD;
}

function getLogSizeThreshold(): number {
  return LOG_SIZE_THRESHOLD;
}

function formatLogSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

function createLogStream(logPath: string): WriteStream {
  return createWriteStream(logPath, { flags: "w" });
}

function cleanOldLogFiles(
  logDirName: string,
  retentionHours: number,
): void {
  const dir = getLogDirectory(logDirName);
  if (!existsSync(dir)) return;

  const now = Date.now();
  const retentionMs = retentionHours * 60 * 60 * 1000;

  const files = readdirSync(dir);
  for (const file of files) {
    if (!file.endsWith(".log")) continue;

    const filePath = join(dir, file);
    try {
      const stats = statSync(filePath);
      if (now - stats.birthtimeMs > retentionMs) {
        unlinkSync(filePath);
      }
    } catch {
      // ignore files removed by another process
    }
  }
}
