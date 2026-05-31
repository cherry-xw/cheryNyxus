import { createWriteStream, mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import type { WriteStream } from 'fs';

export interface BashLogInfo {
  pid: number;
  command: string;
  startTime: number;
  logPath: string;
  description?: string;
  status: 'running' | 'completed' | 'killed';
}

const LOG_DIR_NAME = 'cheryClaw-bash-logs';
const LOG_SIZE_THRESHOLD = 10 * 1024; // 10KB

let logDir: string | null = null;

export function getLogDir(): string {
  if (!logDir) {
    logDir = join(tmpdir(), LOG_DIR_NAME);
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
  }
  return logDir;
}

export function createLogFile(pid: number, startTime: number): string {
  const dir = getLogDir();
  const filename = `${startTime}-${pid}.log`;
  return join(dir, filename);
}

export function formatLogHeader(info: BashLogInfo): string {
  const startTimeStr = new Date(info.startTime).toLocaleString('zh-CN', {
    hour12: false
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

export function getLogSize(logPath: string): number {
  try {
    return statSync(logPath).size;
  } catch {
    return 0;
  }
}

export function shouldShowPartialLog(logPath: string): boolean {
  return getLogSize(logPath) > LOG_SIZE_THRESHOLD;
}

export function getLogSizeThreshold(): number {
  return LOG_SIZE_THRESHOLD;
}

export function formatLogSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)}KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
  }
}

export function createLogStream(logPath: string): WriteStream {
  return createWriteStream(logPath, { flags: 'w' });
}

export function cleanOldLogs(retentionHours: number): void {
  const dir = getLogDir();
  if (!existsSync(dir)) {
    return;
  }

  const now = Date.now();
  const retentionMs = retentionHours * 60 * 60 * 1000;

  const files = readdirSync(dir);
  for (const file of files) {
    if (!file.endsWith('.log')) {
      continue;
    }

    const filePath = join(dir, file);
    try {
      const stats = statSync(filePath);
      if (now - stats.birthtimeMs > retentionMs) {
        unlinkSync(filePath);
      }
    } catch {
      // 文件可能已被删除，忽略错误
    }
  }
}