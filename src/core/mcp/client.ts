import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig } from '@/utils/config.js'
import type { McpClientHandle } from './types.js'

/** 客户端自我声明，MCP 握手时上报给 server */
const CLIENT_INFO = { name: 'cherynyxus', version: '1.0.0' }

/**
 * 按 McpServerConfig 构造传输层。
 * stdio：spawn 子进程，stdin/stdout 通信；streamable-http：HTTP POST + SSE。
 */
function buildTransport(cfg: McpServerConfig) {
  if (cfg.transport === 'stdio') {
    if (!cfg.command) throw new Error('扩展工具配置不全（缺 command）')
    return new StdioClientTransport({ command: cfg.command, args: cfg.args, env: cfg.env })
  }
  if (cfg.transport === 'streamable-http') {
    if (!cfg.url) throw new Error('扩展工具配置不全（缺 url）')
    return new StreamableHTTPClientTransport(new URL(cfg.url))
  }
  throw new Error(`扩展工具用了不支持的连接方式（${cfg.transport}）`)
}

/**
 * 连接一个 MCP server，完成握手，返回 client 句柄。
 * 失败抛错，由 loader 捕获后 warn 跳过（不阻断启动）。
 */
export async function connectMcpServer(
  name: string,
  cfg: McpServerConfig,
): Promise<McpClientHandle> {
  const transport = buildTransport(cfg)
  const client = new Client(CLIENT_INFO, { capabilities: {} })
  await client.connect(transport)
  return { name, client, close: () => client.close() }
}
