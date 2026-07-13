import { spawn } from "node:child_process";

export interface SystemOpenCommand {
  command: string;
  args: string[];
}

/** 解析系统默认打开命令；独立导出便于覆盖三平台参数。 */
export function resolveSystemOpenCommand(
  target: string,
  platform: NodeJS.Platform = process.platform,
): SystemOpenCommand {
  if (platform === "win32") {
    return { command: "cmd", args: ["/d", "/s", "/c", "start", "", target] };
  }
  if (platform === "darwin") {
    return { command: "open", args: [target] };
  }
  return { command: "xdg-open", args: [target] };
}

/**
 * 使用系统默认应用打开文件或目录。
 * `spawn` 事件表示系统打开进程已成功启动；命令不存在等启动错误会 reject。
 */
export function openWithSystem(target: string): Promise<void> {
  const { command, args } = resolveSystemOpenCommand(target);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
