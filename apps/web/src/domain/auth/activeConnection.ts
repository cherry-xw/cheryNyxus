export interface ActiveConnectionSummary {
  schemaVersion: 1
  revision: number
  status: 'active' | 'switching' | 'signed-out' | 'locked'
  origin: string
  basePath: string
  backendId: string
  displayIdentity: string
  expiresAt?: string
}
/** Storage describes a target only, never an authenticated identity. */
export function parseActiveConnection(raw: string | null, expectedOrigin: string): ActiveConnectionSummary | null {
  try {
    const v = JSON.parse(raw ?? 'null')
    if (!v || v.schemaVersion !== 1 || v.origin !== expectedOrigin || !Number.isSafeInteger(v.revision) || v.revision < 0 || !['active', 'switching', 'signed-out', 'locked'].includes(v.status)) return null
    if (typeof v.basePath !== 'string' || (v.basePath !== '' && (!v.basePath.startsWith('/') || v.basePath.startsWith('//'))) || /[\\?#%\x00-\x20]/.test(v.basePath) || v.basePath.split('/').some((x: string) => x === '.' || x === '..')) return null
    if (typeof v.backendId !== 'string' || (v.backendId !== '' && !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(v.backendId)) || typeof v.displayIdentity !== 'string' || v.displayIdentity.length > 512) return null
    if (v.expiresAt !== undefined && (typeof v.expiresAt !== 'string' || !Number.isFinite(Date.parse(v.expiresAt)))) return null
    if (Object.keys(v).some((key) => !['schemaVersion', 'revision', 'status', 'origin', 'basePath', 'backendId', 'displayIdentity', 'expiresAt'].includes(key))) return null
    return v
  } catch { return null }
}
