import type { BrainServiceCapabilities } from '@chery/protocol'
import { replaceEnvVars } from '@/utils/config.js'
import { resolveBrainProtocol } from '@/core/llm/routing.js'
import { resolveEffectiveBrainCapabilities, resolveModelCatalog, type CatalogCapabilities } from '@/utils/modelCatalog.js'
import { createServerToolScope, type ServerToolConnection } from '@/utils/serverToolScope.js'
import { listServerToolObservations } from '@/db/serverToolObservations.js'

/** Shared by the settings draft query and config_manage; no remote requests or config writes. */
export function readBrainServiceCapabilities(
  connection: ServerToolConnection & { capabilities?: CatalogCapabilities },
): BrainServiceCapabilities {
  const resolved = replaceEnvVars(connection) as typeof connection
  const protocol = resolveBrainProtocol(resolved)
  const input = { ...resolved, protocol, userCapabilities: connection.capabilities }
  const effective = resolveEffectiveBrainCapabilities(input)
  const catalog = resolveModelCatalog(input)
  const definitions = catalog.recommend?.capabilities?.serverToolDefinitions ??
    catalog.facts?.capabilities?.serverToolDefinitions ?? []
  const scopeId = createServerToolScope(resolved, connection.key?.startsWith('$') ? connection.key : undefined)
  const result: BrainServiceCapabilities = {
    nativeInput: effective.input,
    serverTools: effective.serverTools,
    connectionIdentified: scopeId !== undefined,
    verification: { status: 'not-verified' },
    catalogComplete: false,
    observationsTruncated: false,
    knownTools: definitions.map(tool => ({ ...tool, sources: ['catalog'] })),
  }
  if (!scopeId) return result
  try {
    const observations = listServerToolObservations(scopeId)
    result.observationsTruncated = observations.truncated
    for (const observation of observations.tools) {
      const existing = result.knownTools.find(tool => tool.name === observation.name)
      if (existing) {
        existing.sources.push('observed')
        existing.observation = observation
      } else {
        result.knownTools.push({ name: observation.name, sources: ['observed'], observation })
      }
    }
  } catch {
    result.observationError = '工具观察记录暂时无法读取，请稍后刷新；目录说明不受影响。'
  }
  return result
}
