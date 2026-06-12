import { registerBuiltinProviders } from "./provider/index.js";
import { reloadSenses } from "./sense/index.js";

/**
 * 启动期初始化 agent 运行时全局注册表。
 *
 * Provider 与 Sense 都是进程级 registry，应在服务启动前显式完成，
 * AgentBuilder 只消费 registry，不负责校验或懒加载。
 */
export async function bootstrapAgentRuntime(): Promise<void> {
  registerBuiltinProviders();
  await reloadSenses();
}
