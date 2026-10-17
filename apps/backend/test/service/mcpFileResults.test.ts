import { afterEach, describe, expect, it, vi } from 'vitest'
import { toolToSense, setMcpToolResultHandler } from '@/core/mcp/convert.js'
import { registerMcpFileResults } from '@/service/media/mcpResults.js'
import type { McpSenseContext } from '@/core/mcp/types.js'

const store = vi.hoisted(() => ({
  save: vi.fn(async () => ({ id: 'asset', versionId: 'version', originalName: 'result', mimeType: 'application/octet-stream', kind: 'file' })),
  attachOwned: vi.fn(),
}))
vi.mock('@/service/media/store.js', () => ({ getAssetStore: () => store }))
vi.mock('@/service/media/access.js', () => ({ fileAccessForChat: () => ({ ownerId: 'owner', chatId: 'chat' }) }))

afterEach(() => { setMcpToolResultHandler(); vi.clearAllMocks() })

describe('MCP 文件结果', () => {
  it('按顺序保存内嵌文件，保留映射数据，并区分工具错误', async () => {
    registerMcpFileResults()
    const callTool = vi.fn().mockResolvedValue({ content: [
      { type: 'text', text: '文件说明' },
      { type: 'resource', resource: { uri: 'file:///remote/private.txt', mimeType: 'text/plain', blob: Buffer.from('hello').toString('base64') } },
      { type: 'resource_link', uri: 'file:///do-not-read' },
    ], structuredContent: { data: { text: '已完成' } } })
    const tool = toolToSense({ name: 'generate' }, { client: { callTool }, serverName: 'test', defaultSupervision: 0 } as unknown as McpSenseContext)
    const result = await tool.executor.execute({}, new Map(), { chatId: 'chat', messageId: 'call' })
    expect(result.status).toBe('ok')
    expect(result.parts?.map(part => part.type)).toEqual(['text', 'asset', 'text'])
    expect(result.content).toBe('{"data":{"text":"已完成"}}')
    expect(store.save).toHaveBeenCalledWith(Buffer.from('hello'), expect.objectContaining({ ownerId: 'owner' }))
    expect(store.attachOwned).toHaveBeenCalledWith(expect.any(Array), { ownerId: 'owner', chatId: 'chat' }, 'message', 'call')
    callTool.mockResolvedValueOnce({ content: [{ type: 'text', text: '服务拒绝' }], isError: true })
    expect((await tool.executor.execute({}, new Map(), { chatId: 'chat', messageId: 'call-2' })).status).toBe('provider_error')
    expect(store.save).toHaveBeenCalledTimes(1)
  })

  it('后续结果无效时仍交付此前已保存的文件，不误报成功', async () => {
    registerMcpFileResults()
    const tool = toolToSense({ name: 'partial' }, { client: { callTool: vi.fn().mockResolvedValue({ content: [
      { type: 'resource', resource: { mimeType: 'text/plain', blob: Buffer.from('file').toString('base64') } },
      { type: 'audio', mimeType: 'audio/wav', data: 'invalid base64' },
    ] }) }, serverName: 'test', defaultSupervision: 0 } as unknown as McpSenseContext)
    const result = await tool.executor.execute({}, new Map(), { chatId: 'chat', messageId: 'partial-call' })
    expect(result.status).toBe('provider_error')
    expect(result.outputAssetIds).toEqual(['asset'])
    expect(result.parts?.map(part => part.type)).toEqual(['asset', 'text'])
    expect(result.content).toContain('未完整保存')
    expect(store.save).toHaveBeenCalledTimes(1)
  })

  it('工具报告错误仍保存随响应返回的有效文件，不把整批当作成功', async () => {
    registerMcpFileResults()
    const tool = toolToSense({ name: 'partial' }, { client: { callTool: vi.fn().mockResolvedValue({ isError: true, content: [
      { type: 'resource', resource: { mimeType: 'text/plain', blob: Buffer.from('saved partial').toString('base64') } },
      { type: 'text', text: '第二项处理失败' },
    ] }) }, serverName: 'test', defaultSupervision: 0 } as unknown as McpSenseContext)
    const result = await tool.executor.execute({}, new Map(), { chatId: 'chat', messageId: 'call' })
    expect(result.status).toBe('provider_error')
    expect(result.outputAssetIds).toEqual(['asset'])
    expect(result.parts?.map(part => part.type)).toEqual(['asset', 'text'])
    expect(result.content).toContain('返回错误')
  })
})
