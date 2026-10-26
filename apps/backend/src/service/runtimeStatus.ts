import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { BACKEND_STATUS_INTERVAL_MS, BackendStatusSchema } from '@chery/protocol'

/** Publish one complete observation; a delayed/failed write never extends its age. */
export function writeBackendStatusFile(options: {
  file: string
  instanceId: string
  addresses: unknown
  agents: unknown
  now?: number
}): void {
  const status = BackendStatusSchema.parse({ protocolVersion: 2, instanceId: options.instanceId,
    status: 'running', heartbeatIntervalMs: BACKEND_STATUS_INTERVAL_MS,
    addresses: options.addresses, agents: options.agents, updatedAt: new Date(options.now ?? Date.now()).toISOString() })
  mkdirSync(dirname(options.file), { recursive: true })
  const temporary = `${options.file}.${randomBytes(12).toString('hex')}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify(status) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temporary, options.file)
  } finally { rmSync(temporary, { force: true }) }
}
