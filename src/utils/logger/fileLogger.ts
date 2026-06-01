import { createWriteStream, mkdirSync, existsSync, statSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { WriteStream } from "fs";

const LOG_SIZE_THRESHOLD = 10 * 1024;

const logDirCache = new Map<string, string>();

export function getLogDirectory(name: string): string {
  const cached = logDirCache.get(name);
  if (cached) return cached;

  const dir = join(tmpdir(), name);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  logDirCache.set(name, dir);
  return dir;
}

export function createLogFilePath(logDirName: string, filename: string): string {
  return join(getLogDirectory(logDirName), filename);
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
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(2)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)}MB`;
}

export function createLogStream(logPath: string): WriteStream {
  return createWriteStream(logPath, { flags: "w" });
}

export function cleanOldLogFiles(logDirName: string, retentionHours: number): void {
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
