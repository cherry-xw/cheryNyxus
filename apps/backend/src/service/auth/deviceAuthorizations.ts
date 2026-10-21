import { constants } from 'node:fs'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'
import { DeviceAuthorizationFileSchema, DeviceAuthorizationSchema } from '@chery/protocol'

export class DeviceAuthorizationStore {
  private revision = 0
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly file: string, private readonly backendId: string, private readonly issuer: string) {}
  async load(): Promise<void> {
    let handle
    try { handle = await open(this.file, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024 || (process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()))) throw new Error('Authorization file requires owned 0600 regular file')
      const record = DeviceAuthorizationFileSchema.parse(JSON.parse(await handle.readFile('utf8')))
      if (record.backendId !== this.backendId || record.issuer !== this.issuer) throw new Error('Authorization identity mismatch')
      this.revision = record.revision
      // Persisted relationships are not live authority until the control channel ACK.
    } finally { await handle.close() }
  }
  save(values: Array<{ id: string; revision: number; subject: string }>): Promise<void> {
    const work = this.queue.then(async () => {
      const authorizations = values.map((value) => DeviceAuthorizationSchema.parse(value))
      const record = DeviceAuthorizationFileSchema.parse({ version: 1, backendId: this.backendId, issuer: this.issuer, revision: this.revision + 1, authorizations })
      await mkdir(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${randomBytes(16).toString('hex')}.tmp`
      try {
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify(record) + '\n'); await handle.sync() } finally { await handle.close() }
        await rename(temporary, this.file)
        this.revision = record.revision
      } finally { await rm(temporary, { force: true }) }
    })
    this.queue = work.catch(() => {})
    return work
  }
}
