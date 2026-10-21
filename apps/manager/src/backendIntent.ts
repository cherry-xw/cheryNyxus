import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

export interface BackendIntent {
  schemaVersion: 1
  revision: number
  desiredState: 'running' | 'stopped'
  pluginEnabled: boolean
  operationId: string | null
}

function parseIntent(input: unknown): BackendIntent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Backend 期望状态格式无效')
  const value = input as Record<string, unknown>
  const keys = ['schemaVersion', 'revision', 'desiredState', 'pluginEnabled', 'operationId']
  if (Object.keys(value).some((key) => !keys.includes(key)) || value.schemaVersion !== 1 ||
    typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    (value.desiredState !== 'running' && value.desiredState !== 'stopped') || typeof value.pluginEnabled !== 'boolean' ||
    (value.operationId !== null && (typeof value.operationId !== 'string' || !value.operationId.length || value.operationId.length > 256)))
    throw new Error('Backend 期望状态格式无效')
  return { schemaVersion: 1, revision: value.revision, desiredState: value.desiredState,
    pluginEnabled: value.pluginEnabled, operationId: value.operationId }
}

/** Manager-owned state, independent of Backend and of the auto-start preference. */
export class BackendIntentStore {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly file: string) {}

  async read(): Promise<BackendIntent> {
    try {
      return parseIntent(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { schemaVersion: 1, revision: 0, desiredState: 'running', pluginEnabled: true, operationId: null }
    }
  }

  save(patch: Partial<Pick<BackendIntent, 'desiredState' | 'pluginEnabled' | 'operationId'>>): Promise<BackendIntent> {
    const operation = this.queue.then(async () => {
      const previous = await this.read()
      const next = parseIntent({ ...previous, ...patch, revision: previous.revision + 1 })
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = `${this.file}.${randomUUID()}.next`
      try {
        await writeFile(temp, JSON.stringify(next), { flag: 'wx', mode: 0o600 })
        await rename(temp, this.file)
      } finally {
        await unlink(temp).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      }
      return next
    })
    this.queue = operation.catch(() => {})
    return operation
  }

  async shouldAutoStart(autoStart: boolean): Promise<boolean> {
    const state = await this.read()
    return autoStart && state.pluginEnabled && state.desiredState === 'running'
  }
}
