import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from '@/utils/config.js'
import type { McpClientHandle } from '@/core/mcp/types.js'
import { SupervisionLevel } from '@/core/config'

const mocks = vi.hoisted(() => ({
  config: { mcp_servers: {} as Record<string, McpServerConfig> },
  connect: vi.fn(),
}))
vi.mock('@/utils/config.js', () => ({ default: mocks.config }))
vi.mock('@/core/mcp/client.js', () => ({ connectMcpServer: mocks.connect }))
vi.mock('@/utils/logger/index.js', () => ({ logger: { warn: vi.fn() } }))
vi.mock('@/core/sense', async () => import('@/core/sense/senseRegistry.js'))

import {
  classifyMcpChange,
  connectMcpServerByName,
  prepareMcpChanges,
  reloadMcpServers,
  reloadOneServer,
  closeMcpClients,
  disconnectMcpServer,
  getMcpServer,
} from '@/core/mcp/loader.js'
import { getSense, resetSenses } from '@/core/sense/senseRegistry.js'
import { retainMcpExecutors, collectRetiredMcpClients } from '@/core/mcp/lifetime.js'

const http: McpServerConfig = { transport: 'streamable-http', url: 'http://localhost/old' }
const stdio: McpServerConfig = { transport: 'stdio', command: 'mock-old' }
const releases: Array<() => void> = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
function handle(tool = 'read') {
  const close = vi.fn().mockResolvedValue(undefined)
  const client = {
    getServerCapabilities: () => ({ tools: {} }),
    listTools: vi.fn().mockResolvedValue({ tools: [{ name: tool }] }),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: tool }] }),
  }
  return { name: 'a', client, close }
}
function enqueue(value: ReturnType<typeof handle>) {
  mocks.connect.mockResolvedValueOnce(value as unknown as McpClientHandle)
}
async function initial(cfg = http) {
  mocks.config.mcp_servers = { a: cfg }
  const old = handle()
  enqueue(old)
  await connectMcpServerByName('a')
  return old
}
function lease() {
  const executor = getSense('mcp__a__read')!.executor
  const owner = { isRunning: () => false }
  const release = retainMcpExecutors([executor], owner)
  releases.push(release)
  return { owner, release, executor }
}
async function apply(configs: Record<string, McpServerConfig>, names = ['a']) {
  const prepared = await prepareMcpChanges(configs, names)
  try {
    expect(prepared.unsafe()).toBeUndefined()
    prepared.apply()
    prepared.commit()
  } finally {
    await prepared.dispose()
  }
}
beforeEach(() => {
  mocks.connect.mockReset()
  resetSenses()
})
afterEach(async () => {
  releases.splice(0).forEach((release) => release())
  await closeMcpClients()
  await collectRetiredMcpClients()
  mocks.config.mcp_servers = {}
})

describe('MCP resource handoff', () => {
  it('reconnects a deliberately disconnected stdio service by reusing its retained client', async () => {
    const old = await initial(stdio)
    const retained = lease()
    // A real idle chat runtime can release this reference at its next safe refresh.
    retained.release()
    const owner = { isRunning: () => false }
    const release = retainMcpExecutors([retained.executor], owner, true)
    releases.push(release)
    expect((await disconnectMcpServer('a')).status).toBe('disconnected')
    expect(old.close).not.toHaveBeenCalled()
    expect(getSense('mcp__a__read')).toBeUndefined()
    expect((await connectMcpServerByName('a')).status).toBe('connected')
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect((await retained.executor.execute({}, {} as never)).content).toBe('read')
    release()
    await collectRetiredMcpClients()
    expect(old.close).not.toHaveBeenCalled()
  })
  it('does not start another stdio process when the old close fails', async () => {
    const old = await initial(stdio)
    old.close.mockRejectedValueOnce(new Error('close uncertain'))
    await expect(prepareMcpChanges({ a: { ...stdio, command: 'new' } }, ['a'])).rejects.toThrow(
      'close uncertain',
    )
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(getMcpServer('a').status).toBe('failed')
    expect(getMcpServer('a').error).toContain('确认关闭')
  })

  it('does not restore stdio while a failed candidate process is still alive', async () => {
    await initial(stdio)
    const broken = handle('new')
    broken.client.listTools.mockRejectedValueOnce(new Error('probe failed'))
    broken.close.mockRejectedValueOnce(new Error('close uncertain'))
    enqueue(broken)
    await expect(prepareMcpChanges({ a: { ...stdio, command: 'new' } }, ['a'])).rejects.toThrow(
      'probe failed',
    )
    expect(mocks.connect).toHaveBeenCalledTimes(2)
    expect(getMcpServer('a').status).toBe('failed')
    expect(getMcpServer('a').error).toContain('暂缓恢复')
    await collectRetiredMcpClients()
    expect(broken.close).toHaveBeenCalledTimes(2)
  })
  it('classifies connection, supervision, addition, removal and no-op differences', () => {
    expect(classifyMcpChange(undefined, http)).toBe('added')
    expect(classifyMcpChange(http, undefined)).toBe('removed')
    expect(classifyMcpChange(http, { ...http })).toBe('unchanged')
    expect(classifyMcpChange(http, { ...http, supervision: SupervisionLevel.manual })).toBe(
      'supervision',
    )
    expect(classifyMcpChange(stdio, { ...stdio, env: { TOKEN: 'different' } })).toBe('connection')
  })

  it('closes a failed temporary client and keeps old executors and config after listTools failure', async () => {
    const old = await initial()
    const broken = handle('new')
    broken.client.listTools.mockRejectedValueOnce(new Error('secret-url'))
    enqueue(broken)
    await expect(prepareMcpChanges({ a: { ...http, url: 'http://new' } }, ['a'])).rejects.toThrow(
      'secret-url',
    )
    expect(broken.close).toHaveBeenCalledOnce()
    expect(old.close).not.toHaveBeenCalled()
    expect(getSense('mcp__a__read')).toBeDefined()
    expect(getMcpServer('a')).toMatchObject({ status: 'connected', transport: 'streamable-http' })
    expect(getMcpServer('a').error).not.toContain('secret-url')
  })

  it('retains an old runtime for a later call even when no RPC is currently in flight', async () => {
    const old = await initial()
    const retained = lease()
    const next = handle('new')
    enqueue(next)
    await apply({ a: { ...http, url: 'http://new' } })
    expect(old.close).not.toHaveBeenCalled()
    expect(getSense('mcp__a__read')).toBeUndefined()
    const result = await retained.executor.execute({}, {} as never)
    expect(result.content).toBe('read')
    retained.release()
    await collectRetiredMcpClients()
    expect(old.close).toHaveBeenCalledOnce()
    expect(next.close).not.toHaveBeenCalled()
  })

  it('does not close an arbitrarily long call after its runtime lease is released', async () => {
    const old = await initial()
    const retained = lease()
    const reply = deferred<{ content: Array<{ type: string; text: string }> }>()
    old.client.callTool.mockReturnValueOnce(reply.promise)
    const call = retained.executor.execute({}, {} as never)
    enqueue(handle('new'))
    await apply({ a: { ...http, url: 'http://new' } })
    retained.release()
    await collectRetiredMcpClients()
    expect(old.close).not.toHaveBeenCalled()
    reply.resolve({ content: [{ type: 'text', text: 'finished' }] })
    expect((await call).content).toBe('finished')
    await collectRetiredMcpClients()
    expect(old.close).toHaveBeenCalledOnce()
  })

  it('updates supervision without reconnecting', async () => {
    const old = await initial(stdio)
    await apply({ a: { ...stdio, supervision: SupervisionLevel.manual } })
    expect(mocks.connect).toHaveBeenCalledOnce()
    expect(old.close).not.toHaveBeenCalled()
    expect(getSense('mcp__a__read')!.supervisionLevel).toBe(SupervisionLevel.manual)
  })

  it('full reload leaves unchanged servers alone and removes deleted servers', async () => {
    const old = await initial()
    enqueue({ ...handle('other'), name: 'b' })
    mocks.config.mcp_servers.b = http
    await connectMcpServerByName('b')
    await reloadMcpServers()
    expect(mocks.connect).toHaveBeenCalledTimes(2)
    delete mocks.config.mcp_servers.a
    await reloadMcpServers()
    expect(old.close).toHaveBeenCalledOnce()
    expect(getSense('mcp__a__read')).toBeUndefined()
    expect(getSense('mcp__b__other')).toBeDefined()
  })

  it('waits for stdio runtime references, including future calls, before stopping the process', async () => {
    const old = await initial(stdio)
    const retained = lease()
    const pending = await prepareMcpChanges({ a: { ...stdio, command: 'new' } }, ['a'])
    expect(pending.unsafe()).toContain('旧执行器')
    expect(old.close).not.toHaveBeenCalled()
    expect(mocks.connect).toHaveBeenCalledOnce()
    await pending.dispose()
    retained.release()
    const next = handle('new')
    mocks.connect.mockImplementationOnce(async () => {
      expect(old.close).toHaveBeenCalledOnce()
      return next
    })
    await apply({ a: { ...stdio, command: 'new' } })
  })

  it('restores stdio old parameters after candidate failure without overlapping processes', async () => {
    const old = await initial(stdio)
    const broken = handle('broken')
    broken.client.listTools.mockRejectedValueOnce(new Error('probe failed'))
    enqueue(broken)
    const restored = handle()
    mocks.connect.mockImplementationOnce(async (_name, cfg) => {
      expect(old.close).toHaveBeenCalledOnce()
      expect(broken.close).toHaveBeenCalledOnce()
      expect(cfg.command).toBe('mock-old')
      return restored
    })
    await expect(prepareMcpChanges({ a: { ...stdio, command: 'new' } }, ['a'])).rejects.toThrow(
      'probe failed',
    )
    expect(getMcpServer('a').status).toBe('connected')
    await getSense('mcp__a__read')!.executor.execute({}, {} as never)
    expect(restored.client.callTool).toHaveBeenCalledOnce()
  })

  it('reports unavailable stdio when both candidate and recovery fail', async () => {
    await initial(stdio)
    mocks.connect
      .mockRejectedValueOnce(new Error('new fails'))
      .mockRejectedValueOnce(new Error('restore fails'))
    await expect(reloadOneServer('a')).rejects.toThrow('new fails')
    expect(getMcpServer('a')).toMatchObject({ status: 'failed', senseNames: [] })
    expect(getMcpServer('a').error).toContain('也未能恢复')
  })

  it('retains failed-close handles for retry while the new HTTP connection remains usable', async () => {
    const old = await initial()
    old.close.mockRejectedValueOnce(new Error('close failed'))
    const next = handle('new')
    enqueue(next)
    await apply({ a: { ...http, url: 'http://new' } })
    expect(getMcpServer('a').status).toBe('connected')
    expect(next.close).not.toHaveBeenCalled()
    await collectRetiredMcpClients()
    expect(old.close).toHaveBeenCalledTimes(2)
  })

  it('rolls back registry and closes the candidate if tree publication fails', async () => {
    const old = await initial()
    const original = getSense('mcp__a__read')
    const next = handle('new')
    enqueue(next)
    const prepared = await prepareMcpChanges({ a: { ...http, url: 'http://new' } }, ['a'])
    prepared.apply()
    prepared.rollback()
    await prepared.dispose()
    expect(getSense('mcp__a__read')).toBe(original)
    expect(getSense('mcp__a__new')).toBeUndefined()
    expect(next.close).toHaveBeenCalledOnce()
    expect(old.close).not.toHaveBeenCalled()
  })

  it('serializes concurrent preparations through publication and disposal', async () => {
    const old = await initial()
    const first = handle('first')
    const second = handle('second')
    enqueue(first)
    enqueue(second)
    const a = await prepareMcpChanges({ a: { ...http, url: 'http://first' } }, ['a'])
    const bPromise = prepareMcpChanges({ a: { ...http, url: 'http://second' } }, ['a'])
    await Promise.resolve()
    expect(mocks.connect).toHaveBeenCalledTimes(2)
    a.apply()
    a.commit()
    await a.dispose()
    const b = await bPromise
    b.apply()
    b.commit()
    await b.dispose()
    expect(old.close).toHaveBeenCalledOnce()
    expect(first.close).toHaveBeenCalledOnce()
    expect(second.close).not.toHaveBeenCalled()
    expect(getMcpServer('a').senseNames).toEqual(['mcp__a__second'])
  })
})
