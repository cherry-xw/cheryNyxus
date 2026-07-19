import { describe, it, expect, vi, beforeEach } from 'vitest'
import { connectMcpServer } from '@/core/mcp/client.js'
import type { McpServerConfig } from '@/utils/config.js'

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const mockConnect = vi.fn().mockResolvedValue(undefined)
  const mockClose = vi.fn().mockResolvedValue(undefined)
  class Client {
    connect = mockConnect
    close = mockClose
    constructor(_info: any, _opts: any) {}
  }
  return { Client }
})

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => {
  class StdioClientTransport {
    type = 'stdio'
    command: string
    args?: string[]
    env?: Record<string, string>
    constructor(opts: { command: string; args?: string[]; env?: Record<string, string> }) {
      this.command = opts.command
      this.args = opts.args
      this.env = opts.env
    }
  }
  return { StdioClientTransport }
})

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  class StreamableHTTPClientTransport {
    type = 'streamable-http'
    url: string
    constructor(url: URL) {
      this.url = url.toString()
    }
  }
  return { StreamableHTTPClientTransport }
})

describe('connectMcpServer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('connects via stdio transport', async () => {
    const cfg: McpServerConfig = { transport: 'stdio', command: 'node', args: ['server.js'] }
    const handle = await connectMcpServer('test-server', cfg)
    expect(handle.name).toBe('test-server')
    expect(handle.client).toBeDefined()
    expect(typeof handle.close).toBe('function')
  })

  it('connects via streamable-http transport', async () => {
    const cfg: McpServerConfig = { transport: 'streamable-http', url: 'http://localhost:8080/mcp' }
    const handle = await connectMcpServer('http-server', cfg)
    expect(handle.name).toBe('http-server')
    expect(handle.client).toBeDefined()
  })

  it('throws if stdio config missing command', async () => {
    const cfg = { transport: 'stdio' as const }
    await expect(connectMcpServer('bad', cfg)).rejects.toThrow('缺 command')
  })

  it('throws if streamable-http config missing url', async () => {
    const cfg = { transport: 'streamable-http' as const }
    await expect(connectMcpServer('bad', cfg)).rejects.toThrow('缺 url')
  })

  it('throws for unsupported transport', async () => {
    const cfg = { transport: 'websocket' as any }
    await expect(connectMcpServer('bad', cfg)).rejects.toThrow('不支持的连接方式')
  })

  it('close delegates to client.close', async () => {
    const cfg: McpServerConfig = { transport: 'stdio', command: 'node' }
    const handle = await connectMcpServer('close-test', cfg)
    const closeSpy = vi.spyOn(handle.client, 'close')
    await handle.close()
    expect(closeSpy).toHaveBeenCalled()
  })
})
