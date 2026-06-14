/**
 * 测试 harness：bootstrap agent runtime + 启动 WS 服务。
 *
 * vitest forks pool 下每个测试文件独立进程，故 beforeAll 各自 bootstrap + startService。
 * registerBuiltinProviders 有幂等守卫，reloadSenses 无 senses 编译产物时优雅降级。
 */
import type { WebSocketServer } from "ws";
import { bootstrapAgentRuntime } from "@/agent/bootstrap.js";
import { startService } from "@/service/index.js";
import { closeAllDbs } from "@/db/index.js";

export interface AppHandle {
  wss: WebSocketServer;
  url: string;
}

/**
 * 启动测试服务（随机端口避免冲突）。
 * port=0 由系统分配，通过 wss.address() 取实际端口。
 */
export async function startApp(): Promise<AppHandle> {
  await bootstrapAgentRuntime();
  const wss = startService(0);
  const addr = wss.address() as { port: number };
  return { wss, url: `ws://127.0.0.1:${addr.port}` };
}

/**
 * 停止测试服务，关闭所有 DB 连接。
 */
export async function stopApp(handle: AppHandle): Promise<void> {
  await new Promise<void>((resolve) => {
    handle.wss.close(() => resolve());
  });
  closeAllDbs();
}
