import { createHash } from 'node:crypto'
import { resolveLlmProviderDefaultUrl } from '@chery/protocol'
import { resolveBrainProtocol } from '@/core/llm/routing.js'

export interface ServerToolConnection {
  provider: string
  protocol?: string
  model: string
  url?: string
  key?: string
  fullUrl?: boolean
}

/** Only this digest is persisted. Neither raw credentials nor their references leave this boundary. */
export function createServerToolScope(
  connection: ServerToolConnection,
  credentialReference?: string,
): string | undefined {
  const protocol = resolveBrainProtocol(connection)
  const url = connection.url ?? resolveLlmProviderDefaultUrl(connection.provider, protocol)
  if (!connection.provider || !protocol || protocol === 'mock' || !url || !connection.model ||
      /^<[^>]*>$/.test(url) || /^<[^>]*>$/.test(connection.model) ||
      url.startsWith('$') || connection.model.startsWith('$') ||
      (protocol !== 'ollama-chat' && !connection.key) ||
      (connection.key?.startsWith('$') ?? false) || connection.key === '[REDACTED]') return undefined
  // URLs are not otherwise canonicalized: different query/path values may select different services.
  return createHash('sha256').update(JSON.stringify([
    connection.provider, protocol, url.replace(/\/$/, ''), connection.fullUrl === true,
    connection.model, credentialReference ?? null, connection.key ?? null,
  ])).digest('hex')
}
