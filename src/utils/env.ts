import os from "os";
import path from "path";
import dayjs from "dayjs";

interface EnvInfo {
  workDir: string;
  os: string;
  date: string;
  time: string;
}

let envInfo: EnvInfo | null = null;

/**
 * 初始化环境信息（Agent 启动时调用一次）
 */
export function initEnvInfo(workDir: string): void {
  envInfo = {
    workDir,
    os: `${os.type()} ${os.release()}`,
    date: dayjs().format("YYYY-MM-DD"),
    time: dayjs().toISOString(),
  };
}

/**
 * 获取工作目录
 */
export function getWorkDir(): string {
  if (!envInfo) {
    throw new Error("EnvInfo not initialized. Call initEnvInfo() first.");
  }
  return envInfo.workDir;
}

/**
 * 获取操作系统信息
 */
export function getOS(): string {
  if (!envInfo) {
    throw new Error("EnvInfo not initialized. Call initEnvInfo() first.");
  }
  return envInfo.os;
}

/**
 * 获取当前日期（实时更新）
 */
export function getDate(): string {
  return dayjs().format("YYYY-MM-DD");
}

/**
 * 获取当前完整时间（实时更新）
 */
export function getTime(): string {
  return dayjs().toISOString();
}

/**
 * 获取完整环境信息对象（时间字段实时更新）
 */
export function getEnvInfo(): EnvInfo {
  if (!envInfo) {
    throw new Error("EnvInfo not initialized. Call initEnvInfo() first.");
  }
  return {
    ...envInfo,
    date: dayjs().format("YYYY-MM-DD"),
    time: dayjs().toISOString(),
  };
}

/**
 * 转换相对路径为绝对路径
 */
export function resolvePath(inputPath: string): string {
  if (inputPath.startsWith('/')) {
    return inputPath; // 已经是绝对路径
  }
  const workDir = getWorkDir();
  return path.resolve(workDir, inputPath); // 使用 path.resolve 处理 ./ ../ 等
}