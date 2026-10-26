import { open } from 'node:fs/promises'
import { BACKEND_STATUS_VALID_CYCLES, BackendStatusSchema, RelayClientStatusSchema } from '@chery/protocol'

const unknown = (reason: string) => ({ status: 'unknown' as const, reason })

async function readStatus(file: string): Promise<unknown> {
  const handle = await open(file, 'r')
  try {
    if ((await handle.stat()).size > 65_536) throw new Error('status_too_large')
    const buffer = Buffer.alloc(65_537)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > 65_536) throw new Error('status_too_large')
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'))
  } finally { await handle.close() }
}

export async function readBackendStatus(file: string | undefined, now = Date.now(), expectedInstanceId?: string) {
  if (!file) return unknown('status_not_configured')
  try {
    const result = BackendStatusSchema.safeParse(await readStatus(file))
    if (!result.success) return unknown('invalid_status')
    const value = result.data
    if (expectedInstanceId && value.instanceId !== expectedInstanceId) return unknown('instance_identity_mismatch')
    const age = now - Date.parse(value.updatedAt)
    if (age < 0) return unknown('future_status')
    if (age >= value.heartbeatIntervalMs * BACKEND_STATUS_VALID_CYCLES) return unknown('stale_status')
    return value
  } catch { return unknown('invalid_status') }
}

export async function readRelayStatus(file: string | undefined, desired: { backendId?: string; desiredRevision?: string }, now = Date.now()) {
  if (!file) return unknown('status_not_configured')
  try {
    const parsed = RelayClientStatusSchema.safeParse(await readStatus(file))
    if (!parsed.success) return unknown('invalid_status')
    const value = parsed.data
    if (Date.parse(value.updatedAt) > now) return unknown('future_status')
    if (!desired.backendId || value.backendId !== desired.backendId) return unknown('device_identity_mismatch')
    if (!desired.desiredRevision || value.desiredRevision !== desired.desiredRevision || (value.status === 'online' && value.appliedRevision !== desired.desiredRevision)) return unknown('configuration_not_applied')
    if (value.status === 'online' && (!value.leaseExpiresAt || Date.parse(value.leaseExpiresAt) <= now)) return unknown('stale_status')
    // Non-online records are last observations, not proof of a live process.
    return { ...value, ...(value.status === 'online' ? {} : { observedOnly: true }) }
  } catch { return unknown('invalid_status') }
}
