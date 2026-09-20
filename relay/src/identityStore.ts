import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { RelayError } from './errors.js'
import type { RelayBackendCapabilities } from '@chery/protocol/relay'

export interface KnownBackendIdentity {
  backendId: string
  fingerprint: string
  displayName: string
  createdAt: string
  lastSeenAt: string
  capabilities: RelayBackendCapabilities
}

interface IdentityFile {
  version: 1
  backends: KnownBackendIdentity[]
}

export class IdentityStore {
  private readonly identities = new Map<string, KnownBackendIdentity>()

  constructor(private readonly file?: string) {}

  async load(): Promise<void> {
    if (!this.file) return
    const raw = await readFile(this.file, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
    if (!raw) return
    const parsed = JSON.parse(raw) as IdentityFile
    if (parsed.version !== 1 || !Array.isArray(parsed.backends)) {
      throw new Error('Unsupported relay identity file')
    }
    for (const identity of parsed.backends) this.identities.set(identity.backendId, identity)
  }

  list(): KnownBackendIdentity[] {
    return [...this.identities.values()].map((identity) => ({ ...identity }))
  }

  get(backendId: string): KnownBackendIdentity | undefined {
    const value = this.identities.get(backendId)
    return value ? { ...value } : undefined
  }

  async claim(input: {
    backendId: string
    publicKeyDer: Buffer
    displayName: string
    capabilities: RelayBackendCapabilities
    now: Date
  }): Promise<KnownBackendIdentity> {
    const fingerprint = createHash('sha256').update(input.publicKeyDer).digest('base64url')
    const existing = this.identities.get(input.backendId)
    if (existing && existing.fingerprint !== fingerprint) {
      throw new RelayError('BACKEND_ID_CONFLICT', 'Backend ID is already bound to another device')
    }
    const timestamp = input.now.toISOString()
    const identity: KnownBackendIdentity = existing
      ? {
          ...existing,
          displayName: input.displayName,
          capabilities: input.capabilities,
          lastSeenAt: timestamp,
        }
      : {
          backendId: input.backendId,
          fingerprint,
          displayName: input.displayName,
          capabilities: input.capabilities,
          createdAt: timestamp,
          lastSeenAt: timestamp,
        }
    this.identities.set(input.backendId, identity)
    await this.save()
    return { ...identity }
  }

  private async save(): Promise<void> {
    if (!this.file) return
    await mkdir(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    const payload: IdentityFile = { version: 1, backends: this.list() }
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, this.file)
  }
}
