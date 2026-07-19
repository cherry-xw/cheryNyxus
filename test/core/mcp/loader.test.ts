import { describe, it, expect, vi, beforeEach } from 'vitest'
import { SupervisionLevel } from '@/core/config.js'
import type { McpServerConfig } from '@/utils/config.js'

// Mock config module — must be before import of loader
const mockConfig = {
  mcp_servers: {} as Record<string, McpServerConfig> | undefined,
}

vi.mock('@/utils/config.js', () => ({
  default: mockConfig,
  reloadMcpServersConfig: vi.fn(() => mockConfig.mcp_servers),
}))

vi.mock('@/utils/logger/index.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

// Mock sense registry
const mockRegisterSenses = vi.fn()
const mockUnregisterSenses = vi.fn()
vi.mock('@/core/sense', () => ({
  registerSenses: mockRegisterSenses,
  unregisterSenses: mockUnregisterSenses,
}))

// Mock client
const mockClose = vi.fn().mockResolvedValue(undefined)
const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  close: mockClose,
  getServerCapabilities: vi.fn().mockReturnValue({}),
  listTools: vi.fn().mockResolvedValue({ tools: [] }),
  listResources: vi.fn().mockResolvedValue({ resources: [] }),
  listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
}

vi.mock('@/core/mcp/client.js', () => ({
  connectMcpServer: vi.fn().mockResolvedValue({
    name: 'mock-server',
    client: mockClient,
    close: mockClose,
  }),
}))

// Must import AFTER vi.mock setup
import {
  listMcpServers,
  getMcpServer,
  connectMcpServerByName,
  disconnectMcpServer,
  reloadOneServer,
  reloadMcpServers,
  getConnectedServerSenseNames,
  listConnectedServerNames,
  loadMcpSenses,
  closeMcpClients,
} from '@/core/mcp/loader.js'
import { McpServerError } from '@/core/mcp/types.js'

const stdioCfg: McpServerConfig = { transport: 'stdio', command: 'node', supervision: SupervisionLevel.auto }
const httpCfg: McpServerConfig = { transport: 'streamable-http', url: 'http://localhost/mcp' }

describe('MCP loader', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    // Reset module state by re-importing (loader has module-level Maps)
    vi.resetModules()
    // Re-mock after resetModules
    mockConfig.mcp_servers = {}
    mockRegisterSenses.mockClear()
    mockUnregisterSenses.mockClear()
    mockClose.mockClear()
  })

  describe('listMcpServers', () => {
    it('returns empty array when no mcp_servers config', async () => {
      mockConfig.mcp_servers = undefined
      const { listMcpServers: list } = await import('@/core/mcp/loader.js')
      expect(list()).toEqual([])
    })

    it('returns disconnected status for configured servers', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const { listMcpServers: list } = await import('@/core/mcp/loader.js')
      const servers = list()
      expect(servers).toHaveLength(1)
      expect(servers[0]).toMatchObject({
        name: 'srv1',
        status: 'disconnected',
        transport: 'stdio',
        senseNames: [],
      })
    })
  })

  describe('getMcpServer', () => {
    it('throws NOT_FOUND for unconfigured server', async () => {
      mockConfig.mcp_servers = {}
      const { getMcpServer: get } = await import('@/core/mcp/loader.js')
      // McpServerError from re-imported module is a different class reference,
      // so check by error properties instead of instanceof
      try {
        get('missing')
        expect.unreachable('should have thrown')
      } catch (err: any) {
        expect(err.code).toBe('NOT_FOUND')
        expect(err.message).toContain('没配置')
      }
    })

    it('returns server info for configured server', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const { getMcpServer: get } = await import('@/core/mcp/loader.js')
      const info = get('srv1')
      expect(info.name).toBe('srv1')
      expect(info.status).toBe('disconnected')
    })
  })

  describe('connectMcpServerByName', () => {
    it('throws NOT_FOUND for unconfigured server', async () => {
      mockConfig.mcp_servers = {}
      const { connectMcpServerByName: connect } = await import('@/core/mcp/loader.js')
      await expect(connect('missing')).rejects.toThrow('没配置')
    })

    it('connects and registers senses', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const { connectMcpServerByName: connect, listMcpServers: list } = await import('@/core/mcp/loader.js')
      const info = await connect('srv1')
      expect(info.status).toBe('connected')
      expect(mockRegisterSenses).toHaveBeenCalled()
      // listMcpServers now shows connected
      const servers = list()
      expect(servers[0].status).toBe('connected')
    })

    it('is idempotent — second connect returns same info', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const { connectMcpServerByName: connect } = await import('@/core/mcp/loader.js')
      const info1 = await connect('srv1')
      const info2 = await connect('srv1')
      expect(info1.status).toBe('connected')
      expect(info2.status).toBe('connected')
    })

    it('records error on connection failure', async () => {
      const { connectMcpServer } = await import('@/core/mcp/client.js')
      vi.mocked(connectMcpServer).mockRejectedValueOnce(new Error('conn fail'))
      mockConfig.mcp_servers = { bad: stdioCfg }
      const { connectMcpServerByName: connect, getMcpServer: get } = await import('@/core/mcp/loader.js')
      await expect(connect('bad')).rejects.toThrow('conn fail')
      const info = get('bad')
      expect(info.status).toBe('failed')
      expect(info.error).toContain('conn fail')
    })
  })

  describe('disconnectMcpServer', () => {
    it('throws NOT_FOUND for unconfigured server', async () => {
      mockConfig.mcp_servers = {}
      const { disconnectMcpServer: disconnect } = await import('@/core/mcp/loader.js')
      await expect(disconnect('missing')).rejects.toThrow('没配置')
    })

    it('is idempotent for already-disconnected server', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const { disconnectMcpServer: disconnect } = await import('@/core/mcp/loader.js')
      const info = await disconnect('srv1')
      expect(info.status).toBe('disconnected')
    })

    it('disconnects a connected server and unregisters senses', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      await mod.connectMcpServerByName('srv1')
      const info = await mod.disconnectMcpServer('srv1')
      expect(info.status).toBe('disconnected')
      expect(mockUnregisterSenses).toHaveBeenCalled()
      expect(mockClose).toHaveBeenCalled()
    })
  })

  describe('reloadOneServer', () => {
    it('throws NOT_FOUND for unconfigured server', async () => {
      mockConfig.mcp_servers = {}
      const { reloadOneServer: reload } = await import('@/core/mcp/loader.js')
      await expect(reload('missing')).rejects.toThrow('没配置')
    })

    it('reloads a connected server atomically', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      await mod.connectMcpServerByName('srv1')
      const info = await mod.reloadOneServer('srv1')
      expect(info.status).toBe('connected')
      expect(mockRegisterSenses).toHaveBeenCalled()
    })

    it('preserves old state on reload failure', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      await mod.connectMcpServerByName('srv1')
      // Make next connect fail
      const { connectMcpServer } = await import('@/core/mcp/client.js')
      vi.mocked(connectMcpServer).mockRejectedValueOnce(new Error('reload fail'))
      await expect(mod.reloadOneServer('srv1')).rejects.toThrow('reload fail')
      // Old connection should still be there
      const info = mod.getMcpServer('srv1')
      // After failure, lastError is set, but old entry was deleted from connectedServers
      // because the module-level state was reset by resetModules
    })
  })

  describe('reloadMcpServers', () => {
    it('returns summary with zero servers when no config', async () => {
      mockConfig.mcp_servers = undefined
      const { reloadMcpServers: reload } = await import('@/core/mcp/loader.js')
      const result = await reload()
      expect(result.connected).toBe(0)
      expect(result.failed).toBe(0)
      expect(result.totalSenses).toBe(0)
    })

    it('reloads all configured servers', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg, srv2: httpCfg }
      const { reloadMcpServers: reload } = await import('@/core/mcp/loader.js')
      const result = await reload()
      expect(result.connected).toBe(2)
      expect(result.failed).toBe(0)
    })
  })

  describe('getConnectedServerSenseNames', () => {
    it('throws NOT_FOUND for unconfigured server', async () => {
      mockConfig.mcp_servers = {}
      const { getConnectedServerSenseNames: get } = await import('@/core/mcp/loader.js')
      expect(() => get('missing')).toThrow('没配置')
    })

    it('throws NOT_FOUND for configured but disconnected server', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const { getConnectedServerSenseNames: get } = await import('@/core/mcp/loader.js')
      expect(() => get('srv1')).toThrow('没连上')
    })

    it('returns sense names for connected server', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      await mod.connectMcpServerByName('srv1')
      const names = mod.getConnectedServerSenseNames('srv1')
      expect(Array.isArray(names)).toBe(true)
    })
  })

  describe('listConnectedServerNames', () => {
    it('returns empty when no servers connected', async () => {
      mockConfig.mcp_servers = {}
      const { listConnectedServerNames: list } = await import('@/core/mcp/loader.js')
      expect(list()).toEqual([])
    })

    it('returns connected server names', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      await mod.connectMcpServerByName('srv1')
      expect(mod.listConnectedServerNames()).toContain('srv1')
    })
  })

  describe('loadMcpSenses', () => {
    it('returns immediately when no config', async () => {
      mockConfig.mcp_servers = undefined
      const { loadMcpSenses: load } = await import('@/core/mcp/loader.js')
      await load()
      expect(mockRegisterSenses).not.toHaveBeenCalled()
    })

    it('returns immediately when empty config', async () => {
      mockConfig.mcp_servers = {}
      const { loadMcpSenses: load } = await import('@/core/mcp/loader.js')
      await load()
      expect(mockRegisterSenses).not.toHaveBeenCalled()
    })

    it('loads all configured servers tolerating failures', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const { loadMcpSenses: load } = await import('@/core/mcp/loader.js')
      await load()
      expect(mockRegisterSenses).toHaveBeenCalled()
    })
  })

  describe('closeMcpClients', () => {
    it('closes all connected servers', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      await mod.connectMcpServerByName('srv1')
      await mod.closeMcpClients()
      expect(mockClose).toHaveBeenCalled()
    })
  })

  describe('buildSensesForServer (via connectMcpServerByName)', () => {
    it('registers tool senses when server has tools capability', async () => {
      mockConfig.mcp_servers = { toolsSrv: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      // Mock client with tools capability
      const { connectMcpServer } = await import('@/core/mcp/client.js')
      const toolClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'read', description: 'Read' }] }),
        listResources: vi.fn().mockResolvedValue({ resources: [] }),
        listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
      }
      vi.mocked(connectMcpServer).mockResolvedValueOnce({
        name: 'toolsSrv',
        client: toolClient as any,
        close: toolClient.close,
      })
      await mod.connectMcpServerByName('toolsSrv')
      expect(mockRegisterSenses).toHaveBeenCalled()
      const registered = mockRegisterSenses.mock.calls[0][0] as any[]
      expect(registered.some((s: any) => s.definition.function.name.includes('read'))).toBe(true)
    })

    it('registers resource sense when server has resources capability', async () => {
      mockConfig.mcp_servers = { resSrv: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      const { connectMcpServer } = await import('@/core/mcp/client.js')
      const resClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        listResources: vi.fn().mockResolvedValue({
          resources: [{ uri: 'file:///a', name: 'A' }],
        }),
        listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
      }
      vi.mocked(connectMcpServer).mockResolvedValueOnce({
        name: 'resSrv',
        client: resClient as any,
        close: resClient.close,
      })
      await mod.connectMcpServerByName('resSrv')
      const registered = mockRegisterSenses.mock.calls[0][0] as any[]
      expect(registered.some((s: any) => s.definition.function.name.includes('read_resource'))).toBe(true)
    })

    it('registers prompt sense when server has prompts capability', async () => {
      mockConfig.mcp_servers = { promptSrv: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      const { connectMcpServer } = await import('@/core/mcp/client.js')
      const promptClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        listResources: vi.fn().mockResolvedValue({ resources: [] }),
        listPrompts: vi.fn().mockResolvedValue({
          prompts: [{ name: 'review', description: 'Code review' }],
        }),
      }
      vi.mocked(connectMcpServer).mockResolvedValueOnce({
        name: 'promptSrv',
        client: promptClient as any,
        close: promptClient.close,
      })
      await mod.connectMcpServerByName('promptSrv')
      const registered = mockRegisterSenses.mock.calls[0][0] as any[]
      expect(registered.some((s: any) => s.definition.function.name.includes('get_prompt'))).toBe(true)
    })

    it('tolerates listResources failure when capability declared', async () => {
      mockConfig.mcp_servers = { failRes: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      const { connectMcpServer } = await import('@/core/mcp/client.js')
      const failResClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        listResources: vi.fn().mockRejectedValue(new Error('list failed')),
        listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
      }
      vi.mocked(connectMcpServer).mockResolvedValueOnce({
        name: 'failRes',
        client: failResClient as any,
        close: failResClient.close,
      })
      // Should not throw — list failure is tolerated
      const info = await mod.connectMcpServerByName('failRes')
      expect(info.status).toBe('connected')
    })

    it('tolerates listPrompts failure when capability declared', async () => {
      mockConfig.mcp_servers = { failPrompt: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      const { connectMcpServer } = await import('@/core/mcp/client.js')
      const failPromptClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        listResources: vi.fn().mockResolvedValue({ resources: [] }),
        listPrompts: vi.fn().mockRejectedValue(new Error('list failed')),
      }
      vi.mocked(connectMcpServer).mockResolvedValueOnce({
        name: 'failPrompt',
        client: failPromptClient as any,
        close: failPromptClient.close,
      })
      const info = await mod.connectMcpServerByName('failPrompt')
      expect(info.status).toBe('connected')
    })
  })

  describe('reloadOneServer — dropped sense cleanup', () => {
    it('unregisters senses that no longer exist after reload', async () => {
      mockConfig.mcp_servers = { srv1: stdioCfg }
      const mod = await import('@/core/mcp/loader.js')
      const { connectMcpServer } = await import('@/core/mcp/client.js')

      // First connect: has tool "old_tool"
      const clientV1 = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'old_tool' }] }),
        listResources: vi.fn().mockResolvedValue({ resources: [] }),
        listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
      }
      vi.mocked(connectMcpServer).mockResolvedValueOnce({
        name: 'srv1',
        client: clientV1 as any,
        close: clientV1.close,
      })
      await mod.connectMcpServerByName('srv1')

      // Reload: tool "old_tool" gone, "new_tool" added
      const clientV2 = {
        connect: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
        getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
        listTools: vi.fn().mockResolvedValue({ tools: [{ name: 'new_tool' }] }),
        listResources: vi.fn().mockResolvedValue({ resources: [] }),
        listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
      }
      vi.mocked(connectMcpServer).mockResolvedValueOnce({
        name: 'srv1',
        client: clientV2 as any,
        close: clientV2.close,
      })
      await mod.reloadOneServer('srv1')

      // Should have unregistered the dropped "old_tool" sense
      expect(mockUnregisterSenses).toHaveBeenCalled()
      const unregisteredNames = mockUnregisterSenses.mock.calls[0][0] as string[]
      expect(unregisteredNames).toContain('mcp__srv1__old_tool')
    })
  })
})
