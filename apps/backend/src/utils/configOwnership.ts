import fs from 'node:fs'
import yaml from 'js-yaml'
import { replaceConfigText, withConfigTransactionSync } from './configTransaction.js'

export const BACKEND_CONFIG_KEYS = ['global', 'llm', 'sense_groups', 'mcp_servers', 'roles', 'presets', 'memory'] as const
export function configRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Configuration root must be a mapping')
  return value as Record<string, unknown>
}
/** Replace only Backend business resources; unknown fields belong to other writers. */
export function mergeBackendConfig(current: Record<string, unknown>, candidate: object): Record<string, unknown> {
  const next = structuredClone(current)
  const source = candidate as Record<string, unknown>
  for (const key of BACKEND_CONFIG_KEYS) {
    if (Object.hasOwn(source, key)) next[key] = structuredClone(source[key])
    else delete next[key]
  }
  return next
}
/** Startup must not overwrite a password rotated since its config was loaded. */
export function persistStartupPasswordHash(file: string, original: string, hashed: string): void {
  withConfigTransactionSync(file, () => {
    const text = fs.readFileSync(file, 'utf8')
    const root = configRecord(yaml.load(text))
    const server = configRecord(root.server)
    const auth = configRecord(server.auth)
    if (auth.password !== original) throw new Error('Startup password changed on disk; refusing stale hash write')
    auth.password = hashed
    replaceConfigText(file, yaml.dump(root, { lineWidth: -1 }), text)
  })
}
