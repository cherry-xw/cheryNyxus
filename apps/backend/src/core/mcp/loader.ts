import { isDeepStrictEqual } from 'node:util'
import type { ZodType } from 'zod'
import config, { type McpServerConfig } from '@/utils/config.js'
import { registerSenses, unregisterSenses } from '@/core/sense'
import { captureSenseRegistryRestore } from '@/core/sense/senseRegistry.js'
import type { Sense } from '@/core/sense'
import { connectMcpServer } from './client.js'
import { toolToSense, resourceToSense, promptToSense } from './convert.js'
import {
  MCP_PREFIX,
  PROMPT_SENSE_SUFFIX,
  RESOURCE_SENSE_SUFFIX,
  McpServerError,
  type McpSenseContext,
  type McpServerInfo,
} from './types.js'
import {
  McpLifetime,
  trackMcpSenses,
  collectRetiredMcpClients,
  hasRetiredMcpProcess,
} from './lifetime.js'

interface ConnectedEntry {
  disconnected?: boolean
  stale?: boolean
  lifetime: McpLifetime
  cfg: McpServerConfig
  senses: Sense<ZodType>[]
  senseNames: string[]
}
const connectedServers = new Map<string, ConnectedEntry>()
const lastError = new Map<string, { message: string; candidate?: boolean }>()
let operation: Promise<void> = Promise.resolve()
let applyStatus: ((name: string) => Pick<McpServerInfo, 'applyStatus' | 'applyReason'>) | undefined

export function setMcpReloadCoordinator(status?: typeof applyStatus): void {
  applyStatus = status
}

export function classifyMcpChange(before?: McpServerConfig, after?: McpServerConfig) {
  if (!before) return after ? 'added' : 'unchanged'
  if (!after) return 'removed'
  if (isDeepStrictEqual(before, after)) return 'unchanged'
  const { supervision: _a, ...a } = before
  const { supervision: _b, ...b } = after
  return isDeepStrictEqual(a, b) ? 'supervision' : 'connection'
}

async function listAllMcpTools(client: McpSenseContext['client']) {
  const tools: Awaited<ReturnType<typeof client.listTools>>['tools'] = []
  const seenCursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 50; page++) {
    const res = (cursor ? await client.listTools({ cursor }) : await client.listTools()) as {
      tools?: Awaited<ReturnType<typeof client.listTools>>['tools']
      nextCursor?: string
    }
    if (Array.isArray(res?.tools)) tools.push(...res.tools)
    const next =
      typeof res?.nextCursor === 'string' && res.nextCursor.trim()
        ? res.nextCursor.trim()
        : undefined
    if (!next || seenCursors.has(next)) break
    seenCursors.add(next)
    cursor = next
  }
  return tools
}

async function buildSensesForServer(name: string, cfg: McpServerConfig): Promise<ConnectedEntry> {
  const lifetime = new McpLifetime(await connectMcpServer(name, cfg), cfg.transport === 'stdio')
  try {
    const ctx: McpSenseContext = {
      get client() {
        return lifetime.handle.client
      },
      serverName: name,
      defaultSupervision: cfg.supervision,
    }
    const senses: Sense<ZodType>[] = []
    const client = lifetime.handle.client
    const caps = client.getServerCapabilities()
    if (caps?.tools) {
      const tools = await listAllMcpTools(client)
      senses.push(...tools.map((tool) => toolToSense(tool, ctx)))
      const notifyTarget = client as unknown as {
        fallbackNotificationHandler?: (notification: { method?: string }) => Promise<void>
      }
      const prevHandler = notifyTarget.fallbackNotificationHandler
      notifyTarget.fallbackNotificationHandler = async (notification) => {
        if (notification?.method === 'notifications/tools/list_changed') {
          await refreshMcpServerTools(name).catch(() => {})
        }
        if (prevHandler) await prevHandler(notification)
      }
    }
    if (caps?.resources) {
      const resources = await client
        .listResources()
        .then((result) => result.resources)
        .catch(() => [])
      senses.push(resourceToSense(resources, ctx))
    }
    if (caps?.prompts) {
      const prompts = await client
        .listPrompts()
        .then((result) => result.prompts)
        .catch(() => [])
      senses.push(promptToSense(prompts, ctx))
    }
    trackMcpSenses(senses, lifetime)
    return {
      lifetime,
      cfg: structuredClone(cfg),
      senses,
      senseNames: senses.map((s) => s.definition.function.name),
    }
  } catch (error) {
    lifetime.retire()
    await lifetime.collect()
    throw error
  }
}

/** Only selected servers are touched. The caller publishes within its tree transaction. */
export async function prepareMcpChanges(
  configs: Record<string, McpServerConfig>,
  names: string[],
  disconnect = false,
) {
  const previous = operation
  let unlock!: () => void
  operation = new Promise<void>((resolve) => {
    unlock = resolve
  })
  await previous
  await collectRetiredMcpClients()
  const old = new Map(names.map((name) => [name, connectedServers.get(name)]))
  const next = new Map<string, ConnectedEntry | undefined>()
  const stopped = new Set<ConnectedEntry>()
  let published = false
  let committed = false
  let disposed = false
  let restoreRegistry: (() => void) | undefined
  const unsafe = () =>
    names.some((name) => {
      const entry = old.get(name)
      if (hasRetiredMcpProcess(name, entry?.lifetime)) return true
      if (entry?.disconnected && classifyMcpChange(entry.cfg, configs[name]) === 'unchanged')
        return false
      return (
        entry &&
        (entry.cfg.transport === 'stdio' || configs[name]?.transport === 'stdio') &&
        entry.lifetime.busy()
      )
    })
      ? '等待 MCP 旧执行器或在途调用释放；stdio 服务不能同时启动两份'
      : undefined

  async function restoreStopped() {
    for (const [name, entry] of old) {
      if (!entry || !stopped.has(entry)) continue
      if (hasRetiredMcpProcess(name)) {
        lastError.set(name, { message: 'MCP 临时进程未能确认关闭，暂缓恢复旧连接，请重试' })
        continue
      }
      try {
        entry.lifetime.handle = await connectMcpServer(name, entry.cfg)
        entry.lifetime.closed = false
        entry.lifetime.suspended = false
      } catch {
        lastError.set(name, { message: 'MCP 新连接失败，旧参数连接也未能恢复，请重试' })
      }
    }
    stopped.clear()
  }

  try {
    if (!unsafe()) {
      for (const name of names) {
        const cfg = configs[name]
        const entry = old.get(name)
        if (!cfg) {
          next.set(name, disconnect && entry ? { ...entry, disconnected: true } : undefined)
          continue
        }
        if (
          entry?.disconnected &&
          !entry.lifetime.closed &&
          !entry.lifetime.suspended &&
          classifyMcpChange(entry.cfg, cfg) === 'unchanged'
        ) {
          next.set(name, { ...entry, disconnected: false })
          continue
        }
        if (
          entry &&
          !entry.lifetime.suspended &&
          !entry.lifetime.closed &&
          classifyMcpChange(entry.cfg, cfg) === 'supervision'
        ) {
          next.set(name, {
            ...entry,
            disconnected: false,
            cfg: structuredClone(cfg),
            senses: entry.senses.map((sense) => ({ ...sense, supervisionLevel: cfg.supervision })),
          })
          continue
        }
        if (entry && (entry.cfg.transport === 'stdio' || cfg.transport === 'stdio')) {
          const wasOpen = !entry.lifetime.closed
          entry.lifetime.suspended = true
          try {
            await entry.lifetime.close()
          } catch (error) {
            lastError.set(name, { message: 'MCP 旧连接未能确认关闭，已停止重载，请重试' })
            throw error
          }
          if (wasOpen) stopped.add(entry)
        }
        try {
          next.set(name, await buildSensesForServer(name, cfg))
        } catch (error) {
          lastError.set(name, {
            message: 'MCP 候选连接或工具探测失败，配置尚未生效',
            candidate: true,
          })
          throw error
        }
      }
    }
  } catch (error) {
    for (const [name, entry] of next)
      if (entry && entry.lifetime !== old.get(name)?.lifetime) {
        entry.lifetime.retire()
        await entry.lifetime.collect()
      }
    await restoreStopped()
    unlock()
    throw error
  }

  return {
    unsafe,
    contracts: () =>
      Object.fromEntries(
        [...next].map(([name, entry]) => [
          name,
          entry?.senses.map((sense) => ({
            definition: sense.definition,
            supervision: sense.supervisionLevel,
          })),
        ]),
      ),
    apply() {
      if (unsafe() || next.size !== names.length) throw new Error(unsafe() ?? 'MCP 尚未准备完成')
      restoreRegistry = captureSenseRegistryRestore()
      published = true
      for (const [name, entry] of next) {
        if (entry) {
          if (!entry.disconnected) {
            if (entry.lifetime.retired && !entry.lifetime.revive())
              throw new Error('MCP 旧连接正在关闭，请重试')
            unregisterSenses(old.get(name)?.senseNames ?? [])
            registerSenses(entry.senses)
          }
          connectedServers.set(name, entry)
        } else connectedServers.delete(name)
        const dropped =
          old
            .get(name)
            ?.senseNames.filter(
              (sense) => entry?.disconnected || !entry?.senseNames.includes(sense),
            ) ?? []
        if (dropped.length) unregisterSenses(dropped)
      }
    },
    rollback() {
      if (!published) return
      restoreRegistry?.()
      for (const [name, entry] of old) {
        if (entry) {
          connectedServers.set(name, entry)
          if (entry.disconnected) entry.lifetime.retire()
        } else connectedServers.delete(name)
      }
      published = false
    },
    commit() {
      committed = true
      for (const [name, entry] of old) {
        if (entry && (entry.lifetime !== next.get(name)?.lifetime || next.get(name)?.disconnected))
          entry.lifetime.retire()
        lastError.delete(name)
      }
      stopped.clear()
    },
    async dispose() {
      if (disposed) return
      disposed = true
      try {
        if (!committed) {
          this.rollback()
          for (const [name, entry] of next)
            if (entry && entry.lifetime !== old.get(name)?.lifetime) entry.lifetime.retire()
          await collectRetiredMcpClients()
          await restoreStopped()
        }
        await collectRetiredMcpClients()
      } finally {
        unlock()
      }
    },
  }
}

function buildServerInfo(name: string, cfg: McpServerConfig): McpServerInfo {
  const entry = connectedServers.get(name)
  const available =
    entry && !entry.disconnected && !entry.lifetime.closed && !entry.lifetime.suspended
  const adoption = applyStatus?.(name)
  // Restoring the already applied config is a no-op, so commit() will not run.
  // Only discard obsolete candidate errors; real connection failures survive.
  if (available && adoption?.applyStatus === 'applied' && lastError.get(name)?.candidate)
    lastError.delete(name)
  const error = lastError.get(name)?.message
  return {
    name,
    status: available ? 'connected' : error ? 'failed' : 'disconnected',
    transport: entry?.cfg.transport ?? cfg.transport,
    supervision: entry ? entry.cfg.supervision : cfg.supervision,
    senseNames: available ? entry.senseNames : [],
    ...(error ? { error } : {}),
    ...(available && entry?.stale ? { stale: true } : {}),
    ...adoption,
  }
}

export async function refreshMcpServerTools(name: string): Promise<McpServerInfo> {
  const entry = connectedServers.get(name)
  if (!entry || entry.disconnected || entry.lifetime.closed || entry.lifetime.suspended) {
    return getMcpServer(name)
  }
  const client = entry.lifetime.handle.client
  const caps = client.getServerCapabilities()
  if (!caps?.tools) return getMcpServer(name)
  const ctx: McpSenseContext = {
    get client() {
      return entry.lifetime.handle.client
    },
    serverName: name,
    defaultSupervision: entry.cfg.supervision,
  }
  const resourceSuffix = `${MCP_PREFIX}${name}__${RESOURCE_SENSE_SUFFIX}`
  const promptSuffix = `${MCP_PREFIX}${name}__${PROMPT_SENSE_SUFFIX}`
  try {
    const tools = await listAllMcpTools(client)
    const toolSenses = tools.map((tool) => toolToSense(tool, ctx))
    trackMcpSenses(toolSenses, entry.lifetime)
    const preservedSenses = entry.senses.filter((s) => {
      const fnName = s.definition.function.name
      return fnName === resourceSuffix || fnName === promptSuffix
    })
    const oldToolNames = entry.senseNames.filter(
      (fnName) => fnName !== resourceSuffix && fnName !== promptSuffix,
    )
    unregisterSenses(oldToolNames)
    registerSenses(toolSenses)
    entry.senses = [...toolSenses, ...preservedSenses]
    entry.senseNames = entry.senses.map((s) => s.definition.function.name)
    entry.stale = false
    lastError.delete(name)
  } catch {
    // 刷新失败时保留最后一次已发现列表并标记过期状态，不假装刷新成功
    entry.stale = true
    lastError.set(name, { message: 'MCP 工具列表刷新失败，暂展示上次结果' })
  }
  return getMcpServer(name)
}

export function listMcpServers(): McpServerInfo[] {
  const names = new Set([...Object.keys(config.mcp_servers ?? {}), ...connectedServers.keys()])
  return [...names].map((name) =>
    buildServerInfo(name, config.mcp_servers?.[name] ?? connectedServers.get(name)!.cfg),
  )
}

export function getMcpServer(name: string): McpServerInfo {
  const cfg = config.mcp_servers?.[name] ?? connectedServers.get(name)?.cfg
  if (!cfg) throw new McpServerError(`扩展工具 "${name}" 没配置`, 'NOT_FOUND')
  return buildServerInfo(name, cfg)
}

async function applyStandalone(
  configs: Record<string, McpServerConfig>,
  names: string[],
  disconnect = false,
) {
  const prepared = await prepareMcpChanges(configs, names, disconnect)
  try {
    const reason = prepared.unsafe()
    if (reason) throw new Error(reason)
    prepared.apply()
    prepared.commit()
  } finally {
    await prepared.dispose()
  }
}

export async function connectMcpServerByName(name: string): Promise<McpServerInfo> {
  getMcpServer(name)
  if (getMcpServer(name).status === 'connected') return getMcpServer(name)
  try {
    await applyStandalone(config.mcp_servers ?? {}, [name])
  } catch (error) {
    lastError.set(name, { message: 'MCP 连接失败，请检查服务配置并重试' })
    throw error
  }
  return getMcpServer(name)
}

export async function disconnectMcpServer(name: string): Promise<McpServerInfo> {
  const info = getMcpServer(name)
  await applyStandalone({}, [name], true)
  return { ...info, status: 'disconnected', senseNames: [] }
}

export interface McpReloadResult {
  servers: McpServerInfo[]
  connected: number
  failed: number
  totalSenses: number
}

export function mcpReloadSummary(): McpReloadResult {
  const servers = listMcpServers()
  return {
    servers,
    connected: servers.filter((server) => server.status === 'connected').length,
    failed: servers.filter(
      (server) => server.error || server.status === 'failed' || server.applyStatus === 'failed',
    ).length,
    totalSenses: servers.reduce((sum, server) => sum + server.senseNames.length, 0),
  }
}

export function getConnectedServerSenseNames(name: string): string[] {
  const entry = connectedServers.get(name)
  if (!entry || entry.disconnected || entry.lifetime.closed || entry.lifetime.suspended) {
    getMcpServer(name)
    throw new McpServerError(`扩展工具 "${name}" 没连上`, 'NOT_FOUND')
  }
  return entry.senseNames
}

export function listConnectedServerNames(): string[] {
  return listMcpServers()
    .filter((server) => server.status === 'connected')
    .map((server) => server.name)
}

export async function loadMcpSenses(): Promise<void> {
  for (const name of Object.keys(config.mcp_servers ?? {})) {
    try {
      await connectMcpServerByName(name)
    } catch {
      /* Startup isolates unavailable servers. */
    }
  }
}

export async function closeMcpClients(): Promise<void> {
  for (const entry of connectedServers.values()) {
    unregisterSenses(entry.senseNames)
    entry.lifetime.retire()
  }
  connectedServers.clear()
  await collectRetiredMcpClients()
}
