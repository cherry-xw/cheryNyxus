import { describe, it, expect, vi } from 'vitest'
import { toolToSense, resourceToSense, promptToSense } from '@/core/mcp/convert.js'
import { MCP_PREFIX, RESOURCE_SENSE_SUFFIX, PROMPT_SENSE_SUFFIX } from '@/core/mcp/types.js'
import { SupervisionLevel } from '@/core/config.js'
import type { McpSenseContext } from '@/core/mcp/types.js'

function mockContext(overrides?: Partial<McpSenseContext>): McpSenseContext {
  return {
    client: {
      callTool: vi.fn(),
      readResource: vi.fn(),
      getPrompt: vi.fn(),
    } as any,
    serverName: 'test-srv',
    defaultSupervision: SupervisionLevel.auto,
    ...overrides,
  }
}

describe('toolToSense', () => {
  const ctx = mockContext()

  it('creates sense with mcp__<server>__<tool> naming', () => {
    const sense = toolToSense({ name: 'read_file', description: 'Read a file' }, ctx)
    expect(sense.definition.function.name).toBe('mcp__test-srv__read_file')
    expect(sense.definition.type).toBe('function')
  })

  it('uses tool description or fallback', () => {
    const withDesc = toolToSense({ name: 't1', description: 'My tool' }, ctx)
    expect(withDesc.definition.function.description).toBe('My tool')

    const noDesc = toolToSense({ name: 't2' }, ctx)
    expect(noDesc.definition.function.description).toContain('MCP tool t2')
  })

  it('normalizes inputSchema to parameters', () => {
    const tool = {
      name: 't',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    }
    const sense = toolToSense(tool, ctx)
    const params = sense.definition.function.parameters
    expect(params.type).toBe('object')
    expect(params.properties).toEqual({ path: { type: 'string' } })
    expect(params.required).toEqual(['path'])
    expect(params.additionalProperties).toBe(false)
  })

  it('handles missing inputSchema gracefully', () => {
    const sense = toolToSense({ name: 't' }, ctx)
    expect(sense.definition.function.parameters.properties).toEqual({})
    expect(sense.definition.function.parameters.required).toEqual([])
  })

  it('sets supervisionLevel from context', () => {
    const smartCtx = mockContext({ defaultSupervision: SupervisionLevel.smart })
    const sense = toolToSense({ name: 't' }, smartCtx)
    expect(sense.supervisionLevel).toBe(SupervisionLevel.smart)
  })

  it('executor calls client.callTool and returns text content', async () => {
    const client = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'file content' }],
      }),
    } as any
    const execCtx = mockContext({ client })
    const sense = toolToSense({ name: 'read' }, execCtx)
    const result = await sense.executor.execute({ path: '/tmp/x' })
    expect(result.content).toBe('file content')
    expect(result.hash).toBe('')
    expect(client.callTool).toHaveBeenCalledWith({
      name: 'read',
      arguments: { path: '/tmp/x' },
    })
  })

  it('executor handles isError response', async () => {
    const client = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'permission denied' }],
        isError: true,
      }),
    } as any
    const execCtx = mockContext({ client })
    const sense = toolToSense({ name: 'read' }, execCtx)
    const result = await sense.executor.execute({})
    expect(result.content).toContain('返回错误')
    expect(result.content).toContain('permission denied')
  })

  it('executor catches callTool exception', async () => {
    const client = {
      callTool: vi.fn().mockRejectedValue(new Error('network down')),
    } as any
    const execCtx = mockContext({ client })
    const sense = toolToSense({ name: 'read' }, execCtx)
    const result = await sense.executor.execute({})
    expect(result.content).toContain('MCP call failed')
    expect(result.content).toContain('network down')
  })

  it('executor extracts resource content', async () => {
    const client = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'resource', resource: { text: 'res-text', uri: 'file:///a' } }],
      }),
    } as any
    const execCtx = mockContext({ client })
    const sense = toolToSense({ name: 'read' }, execCtx)
    const result = await sense.executor.execute({})
    expect(result.content).toBe('res-text')
  })

  it('executor handles resource without text', async () => {
    const client = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'resource', resource: { uri: 'file:///a' } }],
      }),
    } as any
    const execCtx = mockContext({ client })
    const sense = toolToSense({ name: 'read' }, execCtx)
    const result = await sense.executor.execute({})
    expect(result.content).toContain('[resource: file:///a]')
  })

  it('executor handles unsupported content type', async () => {
    const client = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'image', data: '...' }],
      }),
    } as any
    const execCtx = mockContext({ client })
    const sense = toolToSense({ name: 'read' }, execCtx)
    const result = await sense.executor.execute({})
    expect(result.content).toContain('[unsupported content type: image]')
  })

  it('extractText returns empty string for non-array content', async () => {
    const client = {
      callTool: vi.fn().mockResolvedValue({ content: 'not an array' }),
    } as any
    const execCtx = mockContext({ client })
    const sense = toolToSense({ name: 'read' }, execCtx)
    const result = await sense.executor.execute({})
    // content is not array, extractText returns '' — but isError is undefined
    expect(result.content).toBe('')
  })

  it('joins multiple content items with newline', async () => {
    const client = {
      callTool: vi.fn().mockResolvedValue({
        content: [
          { type: 'text', text: 'part1' },
          { type: 'text', text: 'part2' },
        ],
      }),
    } as any
    const execCtx = mockContext({ client })
    const sense = toolToSense({ name: 'read' }, execCtx)
    const result = await sense.executor.execute({})
    expect(result.content).toBe('part1\npart2')
  })
})

describe('resourceToSense', () => {
  it('creates sense with read_resource suffix naming', () => {
    const ctx = mockContext()
    const sense = resourceToSense([], ctx)
    expect(sense.definition.function.name).toBe(`${MCP_PREFIX}test-srv__${RESOURCE_SENSE_SUFFIX}`)
  })

  it('lists available resources in description', () => {
    const ctx = mockContext()
    const resources = [
      { uri: 'file:///a', name: 'File A', description: 'desc A' },
      { uri: 'file:///b' },
    ]
    const sense = resourceToSense(resources, ctx)
    expect(sense.definition.function.description).toContain('file:///a')
    expect(sense.definition.function.description).toContain('desc A')
    expect(sense.definition.function.description).toContain('file:///b')
  })

  it('shows fallback message when no resources', () => {
    const ctx = mockContext()
    const sense = resourceToSense([], ctx)
    expect(sense.definition.function.description).toContain('未声明 resources')
  })

  it('requires uri parameter', () => {
    const ctx = mockContext()
    const sense = resourceToSense([], ctx)
    const params = sense.definition.function.parameters
    expect(params.required).toEqual(['uri'])
    expect(params.properties.uri).toBeDefined()
  })

  it('executor calls client.readResource and returns text', async () => {
    const client = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ uri: 'file:///a', text: 'resource text' }],
      }),
    } as any
    const ctx = mockContext({ client })
    const sense = resourceToSense([], ctx)
    const result = await sense.executor.execute({ uri: 'file:///a' })
    expect(result.content).toBe('resource text')
    expect(result.hash).toBe('')
  })

  it('executor handles binary resource (no text)', async () => {
    const client = {
      readResource: vi.fn().mockResolvedValue({
        contents: [{ uri: 'file:///bin', blob: 'base64data' }],
      }),
    } as any
    const ctx = mockContext({ client })
    const sense = resourceToSense([], ctx)
    const result = await sense.executor.execute({ uri: 'file:///bin' })
    expect(result.content).toContain('[binary resource: file:///bin]')
  })

  it('executor catches readResource exception', async () => {
    const client = {
      readResource: vi.fn().mockRejectedValue(new Error('not found')),
    } as any
    const ctx = mockContext({ client })
    const sense = resourceToSense([], ctx)
    const result = await sense.executor.execute({ uri: 'file:///a' })
    expect(result.content).toContain('MCP readResource failed')
    expect(result.content).toContain('not found')
  })
})

describe('promptToSense', () => {
  it('creates sense with get_prompt suffix naming', () => {
    const ctx = mockContext()
    const sense = promptToSense([], ctx)
    expect(sense.definition.function.name).toBe(`${MCP_PREFIX}test-srv__${PROMPT_SENSE_SUFFIX}`)
  })

  it('lists available prompts in description', () => {
    const ctx = mockContext()
    const prompts = [
      { name: 'code_review', description: 'Review code' },
      { name: 'summarize' },
    ]
    const sense = promptToSense(prompts, ctx)
    expect(sense.definition.function.description).toContain('code_review')
    expect(sense.definition.function.description).toContain('Review code')
    expect(sense.definition.function.description).toContain('summarize')
  })

  it('shows fallback message when no prompts', () => {
    const ctx = mockContext()
    const sense = promptToSense([], ctx)
    expect(sense.definition.function.description).toContain('未声明 prompts')
  })

  it('requires name parameter', () => {
    const ctx = mockContext()
    const sense = promptToSense([], ctx)
    const params = sense.definition.function.parameters
    expect(params.required).toEqual(['name'])
    expect(params.properties.name).toBeDefined()
  })

  it('executor calls client.getPrompt and formats messages', async () => {
    const client = {
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          { role: 'user', content: { type: 'text', text: 'review this' } },
          { role: 'assistant', content: { type: 'text', text: 'looks good' } },
        ],
      }),
    } as any
    const ctx = mockContext({ client })
    const sense = promptToSense([], ctx)
    const result = await sense.executor.execute({ name: 'code_review' })
    expect(result.content).toContain('[user] review this')
    expect(result.content).toContain('[assistant] looks good')
    expect(result.hash).toBe('')
  })

  it('executor handles non-text content type', async () => {
    const client = {
      getPrompt: vi.fn().mockResolvedValue({
        messages: [
          { role: 'user', content: { type: 'image' } },
        ],
      }),
    } as any
    const ctx = mockContext({ client })
    const sense = promptToSense([], ctx)
    const result = await sense.executor.execute({ name: 'img' })
    expect(result.content).toContain('[user image]')
  })

  it('executor passes optional arguments', async () => {
    const client = {
      getPrompt: vi.fn().mockResolvedValue({
        messages: [],
      }),
    } as any
    const ctx = mockContext({ client })
    const sense = promptToSense([], ctx)
    await sense.executor.execute({ name: 'p', arguments: { lang: 'ts' } })
    expect(client.getPrompt).toHaveBeenCalledWith({
      name: 'p',
      arguments: { lang: 'ts' },
    })
  })

  it('executor catches getPrompt exception', async () => {
    const client = {
      getPrompt: vi.fn().mockRejectedValue(new Error('prompt missing')),
    } as any
    const ctx = mockContext({ client })
    const sense = promptToSense([], ctx)
    const result = await sense.executor.execute({ name: 'bad' })
    expect(result.content).toContain('MCP getPrompt failed')
    expect(result.content).toContain('prompt missing')
  })
})
