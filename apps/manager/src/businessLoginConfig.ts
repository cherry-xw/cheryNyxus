import { readFile } from 'node:fs/promises'
import { createPublicKey } from 'node:crypto'
import yaml from 'js-yaml'
import { writeYaml } from './credentials.js'
import { withConfigTransaction } from '../../backend/src/utils/configTransaction.js'
import { hashPassword } from '../../backend/src/utils/password.js'

export class BusinessLoginConfigStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string) {}
  private async config(): Promise<Record<string, any>> {
    const raw = await readFile(this.file, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return ''; throw e })
    const parsed = yaml.load(raw)
    if (parsed !== undefined && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) throw new Error('Invalid configuration')
    return (parsed ?? {}) as Record<string, any>
  }
  async view() {
    const config = await this.config(); const server = config.server ?? {}; const auth = server.auth ?? {}
    return { username: auth.username ?? '', passwordConfigured: Boolean(auth.password), businessPreset: server.businessPreset ?? 'full', browserOrigin: auth.browserDeployment?.origin ?? '', browserBasePath: auth.browserDeployment?.basePath ?? '', remoteEnabled: server.remote?.enabled === true, proofIssuer: auth.userProof?.issuer ?? '', proofBackendId: auth.userProof?.backendId ?? '', proofKeys: auth.userProof?.keys ?? {}, restartRequired: true }
  }
  save(input: Record<string, unknown>): Promise<Awaited<ReturnType<BusinessLoginConfigStore['view']>>> {
    const work = this.queue.then(() => withConfigTransaction(this.file, async () => {
      if (typeof input.username !== 'string' || input.username.length > 256 || !input.username.trim() || !['basic', 'full'].includes(String(input.businessPreset))) throw new Error('Invalid business account or preset')
      if (input.password !== undefined && (typeof input.password !== 'string' || input.password.length > 1024 || input.password.length < 12)) throw new Error('Business password requires 12-1024 characters')
      const origin = input.browserOrigin ?? ''; const basePath = input.browserBasePath ?? ''
      if (typeof origin !== 'string' || typeof basePath !== 'string' || (origin && (new URL(origin).origin !== origin || !/^https?:/.test(origin))) || (basePath !== '' && (!basePath.startsWith('/') || basePath.startsWith('//') || basePath.endsWith('/'))) || /[\\?#%\x00-\x20]/.test(basePath) || basePath.split('/').some((p) => p === '.' || p === '..') || (!origin && basePath)) throw new Error('Invalid public origin or prefix')
      const config = await this.config(); const server = config.server ?? {}; const auth = server.auth ?? {}
      if (!input.password && (!auth.password || auth.username !== input.username.trim())) throw new Error('New business identity requires a new password')
      auth.username = input.username.trim(); if (input.password) auth.password = hashPassword(input.password as string)
      if (origin) auth.browserDeployment = { origin, basePath }; else delete auth.browserDeployment
      if (input.remoteEnabled !== undefined) {
        if (typeof input.remoteEnabled !== 'boolean') throw new Error('Invalid remote listener setting')
        server.remote = { ...(server.remote ?? {}), enabled: input.remoteEnabled }
      }
      if (input.proofIssuer !== undefined || input.proofBackendId !== undefined || input.proofKeys !== undefined) {
        const issuer = input.proofIssuer; const backendId = input.proofBackendId; const keys = input.proofKeys
        if (issuer === '' && backendId === '' && keys && typeof keys === 'object' && !Array.isArray(keys) && Object.keys(keys).length === 0) delete auth.userProof
        else {
          if (typeof issuer !== 'string' || typeof backendId !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/.test(backendId) || !keys || typeof keys !== 'object' || Array.isArray(keys)) throw new Error('Invalid proof trust')
          const url = new URL(issuer)
          if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Proof issuer requires HTTPS')
          const entries = Object.entries(keys)
          if (!entries.length || entries.length > 16) throw new Error('At least one trusted public key required')
          for (const [kid, pem] of entries) if (!/^[A-Za-z0-9_-]{16,128}$/.test(kid) || typeof pem !== 'string' || pem.length > 8192 || pem.includes('PRIVATE KEY') || createPublicKey(pem).asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 public keys required')
          auth.userProof = { issuer, backendId, keys, authorizations: [] }
        }
      }
      server.auth = auth; server.businessPreset = input.businessPreset; config.server = server
      await writeYaml(this.file, config)
      return this.view()
    }))
    this.queue = work.catch(() => {})
    return work
  }
}
