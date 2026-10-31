import path from 'node:path'
import { createHash } from 'node:crypto'
import { atomicText, readSafeText, withFileLock } from './files.js'

/** Durable write intent. Recovery must prove an outcome, never assume timeout means not written. */
export async function performWrite<T>(root: string, requestId: string, operationId: string, parameters: unknown,
  action: () => Promise<T>, recover?: () => Promise<T | undefined>, signal?: AbortSignal): Promise<T> {
  const key = createHash('sha256').update(JSON.stringify([requestId, operationId])).digest('hex')
  const fingerprint = createHash('sha256').update(JSON.stringify(parameters)).digest('hex')
  const file = path.join(root, 'write-operations', key + '.json')
  return withFileLock(file, async () => {
    let old: { fingerprint: string; state: 'pending' | 'completed'; result?: T } | undefined
    try { old = JSON.parse(await readSafeText(file)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (old && old.fingerprint !== fingerprint) throw Object.assign(new Error('CONFLICT'), { code: 'CONFLICT' })
    if (old?.state === 'completed') return old.result!
    if (old) {
      const result = await recover?.()
      if (result === undefined) throw Object.assign(new Error('RESULT_UNKNOWN'), { code: 'RESULT_UNKNOWN' })
      await atomicText(file, JSON.stringify({ fingerprint, state: 'completed', result }), signal)
      return result
    }
    await atomicText(file, JSON.stringify({ fingerprint, state: 'pending' }), signal)
    const result = await action()
    await atomicText(file, JSON.stringify({ fingerprint, state: 'completed', result }), signal)
    return result
  }, signal)
}
