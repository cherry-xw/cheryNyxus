import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { AgentBuilder } from '@/agent/builder.js'
import { createChat, deleteChat, getChatMetadata } from '@/db/chat.js'
import { getActiveChatEpoch, getActiveConfigRevision, getFrozenChatSnapshot } from '@/db/epoch.js'
import { ConfigApplyCoordinator } from '@/service/config/applyCoordinator.js'
import { registerRuntimeConfigAdapters } from '@/service/config/runtimeApply.js'
import {
  clearProcessRevisionCache,
  ensureCurrentConfigRevision,
} from '@/service/config/revision.js'
import {
  activateChatRun,
  clearChatRuntime,
  ensureChat,
  releaseChatRun,
} from '@/service/chat/runtime.js'
import { getAppliedRawConfig, replaceRuntimeConfig } from '@/utils/config.js'
import { connectMcpServerByName, closeMcpClients, getMcpServer } from '@/core/mcp/loader.js'
import { getSense } from '@/core/sense/senseRegistry.js'
import { connectMcpServer } from '@/core/mcp/client.js'
import type { McpClientHandle } from '@/core/mcp/types.js'
import type { ConfigImage } from '@/service/config/impact.js'

vi.mock('@/core/mcp/client.js', () => ({ connectMcpServer: vi.fn() }))
const baseline = getAppliedRawConfig()
const chats: string[] = []
const resource = '["mcp_servers","hot"]'
function handle(tool = 'old') {
  return {
    name: 'hot',
    client: {
      getServerCapabilities: () => ({ tools: {} }),
      listTools: vi.fn().mockResolvedValue({ tools: [{ name: tool }] }),
      callTool: vi.fn().mockResolvedValue({ content: [] }),
    },
    close: vi.fn().mockResolvedValue(undefined),
  }
}
function enqueue(value: ReturnType<typeof handle>) {
  vi.mocked(connectMcpServer).mockResolvedValueOnce(value as unknown as McpClientHandle)
}
beforeAll(bootstrapAgentRuntime)
beforeEach(() => {
  vi.mocked(connectMcpServer).mockReset()
  const raw = structuredClone(baseline)
  raw.mcp_servers = { hot: { transport: 'streamable-http', url: 'http://old' } }
  raw.roles = {
    ...raw.roles,
    mcp_a: {
      id: 'role-mcphottest-a',
      brain: 'mock_content',
      senseGroup: 'auto_senses',
      mcpServers: ['hot'],
    },
    mcp_b: { id: 'role-mcphottest-b', brain: 'mock_content', senseGroup: 'auto_senses' },
  }
  raw.presets = {
    ...raw.presets,
    mcp_a: { id: 'preset-mcphottest-a', leader: 'mcp_a', roles: ['mcp_a'] },
    mcp_b: { id: 'preset-mcphottest-b', leader: 'mcp_b', roles: ['mcp_b'] },
  }
  replaceRuntimeConfig(raw)
  clearProcessRevisionCache()
  ensureCurrentConfigRevision()
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const id of chats.splice(0).reverse()) {
    clearChatRuntime(id)
    deleteChat(id)
  }
  await closeMcpClients()
  replaceRuntimeConfig(baseline)
  clearProcessRevisionCache()
})
async function root(name = 'mcp_a') {
  const id = randomUUID()
  chats.push(id)
  createChat(id, { preset: name, presetId: `preset-mcphottest-${name.at(-1)}` })
  await ensureChat(id)
  return id
}
function coordinator() {
  const image: ConfigImage = { config: getAppliedRawConfig(), hooks: {} }
  const engine = new ConfigApplyCoordinator(image)
  registerRuntimeConfigAdapters(engine, image)
  return { engine, image }
}

describe('MCP tree transaction', () => {
  it('replaces an idle stdio tree after closing the old process, then releases its old runtime', async () => {
    const raw = getAppliedRawConfig()
    raw.mcp_servers = { hot: { transport: 'stdio', command: 'old-command' } }
    replaceRuntimeConfig(raw)
    const old = handle()
    enqueue(old)
    await connectMcpServerByName('hot')
    const id = await root()
    const epoch = getActiveChatEpoch(id)!
    const next = handle('new')
    vi.mocked(connectMcpServer).mockImplementationOnce(async () => {
      expect(old.close).toHaveBeenCalledOnce()
      return next as unknown as McpClientHandle
    })
    const { engine, image } = coordinator()
    image.config.mcp_servers!.hot!.command = 'new-command'
    engine.submit(image)
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    expect(getActiveChatEpoch(id)!.epochId).not.toBe(epoch.epochId)
    expect(next.close).not.toHaveBeenCalled()
    expect(getMcpServer('hot').senseNames).toEqual(['mcp__hot__new'])
  })

  it('closes a prepared stdio candidate before restoring old runtime on tree rollback', async () => {
    const raw = getAppliedRawConfig()
    raw.mcp_servers = { hot: { transport: 'stdio', command: 'old-command' } }
    replaceRuntimeConfig(raw)
    enqueue(handle())
    await connectMcpServerByName('hot')
    const id = await root()
    const next = handle('new')
    enqueue(next)
    const restored = handle()
    vi.mocked(connectMcpServer).mockImplementationOnce(async () => {
      expect(next.close).toHaveBeenCalledOnce()
      return restored as unknown as McpClientHandle
    })
    vi.spyOn(AgentBuilder.prototype, 'init').mockImplementationOnce(() => {
      throw new Error('init fails')
    })
    const { engine, image } = coordinator()
    image.config.mcp_servers!.hot!.command = 'new-command'
    engine.submit(image)
    await engine.retry()
    expect(engine.getState().status).toBe('failed')
    expect(getAppliedRawConfig().mcp_servers!.hot!.command).toBe('old-command')
    expect(getMcpServer('hot').status).toBe('connected')
    await getSense('mcp__hot__old')!.executor.execute({}, {} as never)
    expect(restored.client.callTool).toHaveBeenCalledOnce()
    expect(getActiveChatEpoch(id)).toBeDefined()
  })
  it('waits for affected work, keeps unrelated trees, and replaces idle runtime leases on adoption', async () => {
    const old = handle()
    enqueue(old)
    await connectMcpServerByName('hot')
    const a = await root(),
      b = await root('mcp_b')
    const beforeA = getActiveChatEpoch(a)!,
      beforeB = getActiveChatEpoch(b)!
    const otherBuilder = await ensureChat(b)
    activateChatRun(a, 'busy-a')
    const { engine, image } = coordinator()
    image.config.mcp_servers!.hot!.url = 'http://new'
    engine.submit(image)
    await engine.retry()
    expect(engine.getState()).toMatchObject({
      status: 'pending',
      impacts: [expect.objectContaining({ resource, affectedRootChatIds: [a] })],
    })
    expect(connectMcpServer).toHaveBeenCalledOnce()
    expect(old.close).not.toHaveBeenCalled()
    const next = handle('new')
    enqueue(next)
    releaseChatRun(a, 'busy-a')
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    expect(getActiveChatEpoch(a)!.epochId).not.toBe(beforeA.epochId)
    expect(getActiveChatEpoch(b)!.epochId).toBe(beforeB.epochId)
    expect(await ensureChat(b)).toBe(otherBuilder)
    expect(old.close).toHaveBeenCalledOnce()
    expect(next.close).not.toHaveBeenCalled()
    expect(getAppliedRawConfig().mcp_servers!.hot!.url).toBe('http://new')
  })

  it('removes tools from the new epoch without deleting role history or failing on stale runtime selections', async () => {
    const old = handle()
    enqueue(old)
    await connectMcpServerByName('hot')
    const id = await root()
    const { engine, image } = coordinator()
    image.config.mcp_servers = {}
    engine.submit(image)
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    expect(getSense('mcp__hot__old')).toBeUndefined()
    expect(getChatMetadata(id).type).toBe('mcp_a')
    expect(old.close).toHaveBeenCalledOnce()
    const snapshot = getFrozenChatSnapshot(getActiveChatEpoch(id)!.epochId, id)!
    expect(JSON.stringify(snapshot.tools)).not.toContain('mcp__hot__old')
    await expect(ensureChat(id)).resolves.toBeDefined()
  })

  it('rolls back configuration, registry, epoch and temporary runtime leases on initialization failure', async () => {
    const old = handle()
    enqueue(old)
    await connectMcpServerByName('hot')
    const id = await root()
    const before = getActiveChatEpoch(id)!,
      revision = getActiveConfigRevision()!
    const next = handle('new')
    enqueue(next)
    const init = vi.spyOn(AgentBuilder.prototype, 'init').mockImplementationOnce(() => {
      throw new Error('init failed')
    })
    const { engine, image } = coordinator()
    image.config.mcp_servers!.hot!.url = 'http://new'
    engine.submit(image)
    await engine.retry()
    init.mockRestore()
    expect(engine.getState().status).toBe('failed')
    expect(getActiveChatEpoch(id)!.epochId).toBe(before.epochId)
    expect(getActiveConfigRevision()!.revisionId).toBe(revision.revisionId)
    expect(getAppliedRawConfig().mcp_servers!.hot!.url).toBe('http://old')
    expect(getSense('mcp__hot__old')).toBeDefined()
    expect(getSense('mcp__hot__new')).toBeUndefined()
    expect(old.close).not.toHaveBeenCalled()
    expect(next.close).toHaveBeenCalledOnce()
  })

  it('explicit contract reload rotates the epoch even when connection config is unchanged', async () => {
    enqueue(handle())
    await connectMcpServerByName('hot')
    const id = await root()
    const epoch = getActiveChatEpoch(id)!
    const { engine } = coordinator()
    enqueue(handle('new'))
    engine.requestResourceReload(resource)
    expect(engine.getState().status).toBe('pending')
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    expect(getActiveChatEpoch(id)!.epochId).not.toBe(epoch.epochId)
    expect(getMcpServer('hot').senseNames).toEqual(['mcp__hot__new'])
  })

  it('adopts the first server from an empty MCP config', async () => {
    const raw = getAppliedRawConfig()
    raw.mcp_servers = {}
    replaceRuntimeConfig(raw)
    const { engine, image } = coordinator()
    image.config.mcp_servers = { hot: { transport: 'streamable-http', url: 'http://first' } }
    enqueue(handle('first'))
    engine.submit(image)
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    expect(getAppliedRawConfig().mcp_servers!.hot!.url).toBe('http://first')
    expect(getSense('mcp__hot__first')).toBeDefined()
  })

  it('disposes a superseded preparation and only publishes the latest saved candidate', async () => {
    const old = handle()
    enqueue(old)
    await connectMcpServerByName('hot')
    const { engine, image } = coordinator()
    const first = handle('first'),
      second = handle('second')
    let finish!: () => void
    let started!: () => void
    const preparing = new Promise<void>((resolve) => {
      started = resolve
    })
    vi.mocked(connectMcpServer).mockImplementationOnce(async () => {
      started()
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return first as unknown as McpClientHandle
    })
    enqueue(second)
    image.config.mcp_servers!.hot!.url = 'http://first'
    engine.submit(image)
    await preparing
    image.config.mcp_servers!.hot!.url = 'http://second'
    engine.submit(image)
    finish()
    await engine.retry()
    expect(engine.getState().status).toBe('applied')
    expect(getAppliedRawConfig().mcp_servers!.hot!.url).toBe('http://second')
    expect(first.close).toHaveBeenCalledOnce()
    expect(old.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
  })
})
