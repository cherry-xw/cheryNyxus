import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { RelayClientConfigSchema, relayClientRevision } from '../../relay/src/clientConfig.js'

/** Deployment owns the fixed file path; browser input cannot choose a destination. */
export class RelayClientConfigStore {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private readonly file?: string) {}
  async view() {
    if (!this.file) return { configured: false as const, available: false, restartRequired: true, backendId: undefined, url: undefined, desiredRevision: undefined }
    const raw = await readFile(this.file, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return undefined; throw e })
    if (!raw) return { configured: false as const, available: true, restartRequired: true, backendId: undefined, url: undefined, desiredRevision: undefined }
    const parsed = RelayClientConfigSchema.parse(JSON.parse(raw))
    const { encryptedTransport: _secret, ...safe } = parsed
    return { ...safe, desiredRevision: relayClientRevision(parsed), configured: true as const, available: true, encryptedTransportConfigured: true, restartRequired: true }
  }
  save(input: Record<string, unknown>) {
    const work = this.queue.then(async () => {
      if (!this.file) throw new Error('Relay client file is not configured by deployment')
      const existing = await readFile(this.file, 'utf8').catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return '{}'; throw e })
      const previous = JSON.parse(existing)
      const value = RelayClientConfigSchema.parse({ ...input, encryptedTransport: input.encryptedTransport || previous.encryptedTransport })
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${randomBytes(16).toString('hex')}.tmp`
      try { await writeFile(temporary, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' }); await rename(temporary, this.file) }
      finally { await unlink(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e }) }
      return this.view()
    })
    this.queue = work.catch(() => {})
    return work
  }
}
