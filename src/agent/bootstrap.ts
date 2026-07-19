import { registerBuiltinProviders } from './provider/index.js'
import { reloadSenses } from './sense/index.js'
import { loadMcpSenses } from '@/core/mcp/index.js'

/**
 * 启动期初始化 agent 运行时全局注册表。
 *
 * Provider 与 Sense 都是进程级 registry，应在服务启动前显式完成，
 * AgentBuilder 只消费 registry，不负责校验或懒加载。
 *
 * MCP senses 在内置/编译感官之后加载：连接外部 MCP server，把 tools/resources/prompts
 * 转为 Sense 注册。不纳入 reloadSenses，避免 compile-senses 子命令触发外部 server 连接。
 */
export async function bootstrapAgentRuntime(): Promise<void> {
  registerBuiltinProviders()
  await reloadSenses()
  await loadMcpSenses()
}
