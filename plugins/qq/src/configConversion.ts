import { QQConfigSchema } from '@chery/protocol'

/** Explicit offline conversion. The running plugin only accepts the new schema. */
export function convertQQConfiguration(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('INVALID_ARGUMENT')
  const value = structuredClone(input) as Record<string, unknown>
  if (value.schemaVersion === 2) return { config: QQConfigSchema.parse(value), changes: [] as string[] }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) throw new Error('UNSUPPORTED_CONFIG_VERSION')
  const history = value.historyLimit
  if (history === undefined) throw new Error('MISSING_HISTORY_LIMIT')
  const changes = ['historyLimit → backgroundMessageLimit / managementHistoryLimit', '删除 continuationMaxMessages', 'pokeCooldownMs → 独立的 mentionCooldownMs']
  delete value.historyLimit
  delete value.continuationMaxMessages
  return { config: QQConfigSchema.parse({ ...value, schemaVersion: 2, backgroundMessageLimit: history,
    managementHistoryLimit: history, mentionCooldownMs: value.pokeCooldownMs ?? 60000 }), changes }
}
