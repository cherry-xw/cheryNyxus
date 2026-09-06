import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { Method } from '@chery/protocol'
import { bootProtocolService, type ProtocolService } from '../helpers/serviceHarness.js'
import { connectMcpServer } from '@/core/mcp/client.js'
import { closeMcpClients } from '@/core/mcp/loader.js'
import { getConfigApplyCoordinator } from '@/service/config/commit.js'
import type { ConfigGetResponseData, McpReloadResponseData } from '@/service/message/types.js'

vi.mock('@/core/mcp/client.js', () => ({ connectMcpServer: vi.fn() }))
let service: ProtocolService
beforeAll(async () => {
  service = await bootProtocolService()
})
afterAll(async () => {
  await closeMcpClients()
  await service?.close()
})

it('keeps the same WS connection during MCP preparation and reports failed adoption with the old connection available', async () => {
  const pid = process.pid
  const socket = [...service.handle.wss.clients][0]!
  const closed = vi.fn()
  socket.on('close', closed)
  const before = (await service.client.call(Method.CONFIG_GET, {})).data as ConfigGetResponseData
  const { baseRevision, ...candidate } = before
  const oldClose = vi.fn().mockResolvedValue(undefined)
  const oldClient = {
    name: 'protocol-hot',
    close: oldClose,
    client: {
      getServerCapabilities: () => ({ tools: {} }),
      listTools: async () => ({ tools: [] }),
    },
  }
  vi.mocked(connectMcpServer).mockResolvedValueOnce(oldClient as never)
  candidate.mcp_servers = {
    'protocol-hot': { transport: 'streamable-http', url: 'http://mock-old' },
  }
  const saved = await service.client.call(Method.CONFIG_SAVE, {
    protocolVersion: 2,
    requestId: 'mcp-protocol-save',
    expectedBaseRevision: baseRevision,
    candidate,
  })
  expect(saved.error).toBeUndefined()
  await getConfigApplyCoordinator().retry()
  expect(getConfigApplyCoordinator().getState().status).toBe('applied')
  let reject!: (error: Error) => void
  let began!: () => void
  const started = new Promise<void>((resolve) => {
    began = resolve
  })
  vi.mocked(connectMcpServer).mockImplementationOnce(() => {
    began()
    return new Promise((_resolve, fail) => {
      reject = fail
    })
  })
  const reload = service.client.call(Method.MCP_RELOAD, { name: 'protocol-hot' })
  await started
  const status = await service.client.call(Method.CONFIG_APPLY_STATUS, {})
  expect(status.data).toMatchObject({ status: 'pending' })
  expect((await service.client.call(Method.CONFIG_GET, {})).error).toBeUndefined()
  expect(socket.readyState).toBe(1)
  expect(closed).not.toHaveBeenCalled()
  reject(new Error('private endpoint'))
  const result = (await reload).data as McpReloadResponseData
  expect(result.apply?.status).toBe('failed')
  expect(result.servers).toContainEqual(
    expect.objectContaining({ name: 'protocol-hot', status: 'connected', applyStatus: 'failed' }),
  )
  expect(JSON.stringify(result)).not.toContain('private endpoint')
  expect(oldClose).not.toHaveBeenCalled()
  expect(process.pid).toBe(pid)
  expect([...service.handle.wss.clients]).toContain(socket)
  expect(closed).not.toHaveBeenCalled()
})
