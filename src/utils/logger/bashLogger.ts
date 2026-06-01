import { writeFileSync } from "fs";
import {
  cleanOldLogFiles,
  createLogFilePath,
  createLogStream,
  formatLogSize,
  getLogDirectory,
  getLogSize,
  getLogSizeThreshold,
  shouldShowPartialLog,
} from "./fileLogger.js";

export interface BashLogInfo {
  pid: number;
  command: string;
  startTime: number;
  logPath: string;
  description?: string;
  status: "running" | "completed" | "killed";
}

const BASH_LOG_DIR_NAME = "cheryClaw-bash-logs";

export function getBashLogDir(): string {
  return getLogDirectory(BASH_LOG_DIR_NAME);
}

export function createBashLogPath(pid: number, startTime: number): string {
  return createLogFilePath(BASH_LOG_DIR_NAME, `${startTime}-${pid}.log`);
}

export function formatBashLogHeader(info: BashLogInfo): string {
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

export function writeBashTimeoutLog(info: BashLogInfo, output: string): void {
  writeFileSync(info.logPath, formatBashLogHeader(info) + output, "utf-8");
}

export function cleanOldBashLogs(retentionHours: number): void {
  cleanOldLogFiles(BASH_LOG_DIR_NAME, retentionHours);
}

export {
  createLogStream,
  formatLogSize,
  getLogSize,
  getLogSizeThreshold,
  shouldShowPartialLog,
};
