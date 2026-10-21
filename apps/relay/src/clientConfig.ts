import { createHash } from 'node:crypto'
import { z } from 'zod'
import { isAbsolute } from 'node:path'
import { validateEncryptedTransport } from './encryptedTransport.js'

const file = z.string().min(1).max(4096).refine(isAbsolute, 'Absolute file path required')
export const RelayClientConfigSchema = z.object({
  protocolVersion: z.literal(1),
  url: z.string().url().refine((raw) => { const u = new URL(raw); return u.protocol === 'wss:' && !u.username && !u.password && !u.search && !u.hash }),
  backendId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/),
  displayName: z.string().trim().min(1).max(80),
  keyFile: file, authorizationFile: file, ratholeConfigPath: file,
  ratholeServerAddr: z.string().max(512).refine((s) => /^(?:[A-Za-z0-9.-]+|\[[A-Fa-f0-9:]+\]):[1-9]\d{0,4}$/.test(s) && Number(s.slice(s.lastIndexOf(':') + 1)) <= 65535),
  proofIssuer: z.string().url().refine((raw) => { const u = new URL(raw); return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash }),
  encryptedTransport: z.string().min(1).max(8192).refine((s) => { try { validateEncryptedTransport(s, 'client'); return true } catch { return false } }),
  ratholeBinary: file.optional(), statusFile: file.optional(),
}).strict().refine((v) => new Set([v.keyFile, v.authorizationFile, v.ratholeConfigPath, ...(v.statusFile ? [v.statusFile] : [])]).size === (v.statusFile ? 4 : 3), 'Files must be distinct')
export function relayClientRevision(value: RelayClientConfig): string {
  return createHash('sha256').update(JSON.stringify(Object.keys(value).sort().map((key) => [key, value[key as keyof RelayClientConfig]]))).digest('hex')
}
export type RelayClientConfig = z.infer<typeof RelayClientConfigSchema>
