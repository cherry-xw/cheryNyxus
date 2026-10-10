import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { z } from 'zod'
import { QQDefaultConfig, QQConfigSchema, QQIdSchema } from '../../../packages/protocol/src/qq.js'
import { atomicJson, safePath, StateSchema, emptyState } from './state.js'
import { recordSchema } from './memory.js'

const ID = 'cherynyxus-qq-module'
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
interface Change { name: string; before: string | null; after: string }
interface Journal { source: string; selfId: string; backup: string; changes: Change[] }
export interface MigrationOptions {
  /** Explicit offline upgrade of the existing ingress directory. */
  inPlace?: boolean
  memoryRoot?: string
  userFilesRoot?: string
  credentialReferences?: string[]
}
function bytes(file: string): Buffer | undefined {
  safePath(file)
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.size > 25 * 1024 * 1024) throw new Error('Invalid migration file')
    return fs.readFileSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
}
function restore(root: string, transaction: Journal) {
  // Check every target before changing any target; never overwrite a later write.
  for (const item of transaction.changes) {
    const current = bytes(path.join(root, item.name))
    if (current && hash(current) !== item.after && current.toString('base64') !== item.before)
      throw new Error('Rollback conflict: newer data retained')
    if (!current && item.before !== null) throw new Error('Rollback conflict: target removed')
  }
  for (const item of transaction.changes) {
    const file = path.join(root, item.name), current = bytes(file)
    if (current?.toString('base64') === item.before || (!current && item.before === null)) continue
    if (item.before === null) fs.unlinkSync(file)
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temporary = `${file}.${randomUUID()}.restore`
      fs.writeFileSync(temporary, Buffer.from(item.before, 'base64'), { flag: 'wx', mode: 0o600 })
      fs.renameSync(temporary, file)
    }
  }
}
/** Offline only. Copies references, never reads credential values or executes old jobs. */
export function migrateQQ(sourceDirectory: string, ingressRoot: string, trustedSelfId: string,
  fault?: (stage: string) => void, options: MigrationOptions = {}) {
  QQIdSchema.parse(trustedSelfId)
  const source = path.resolve(sourceDirectory), root = path.resolve(ingressRoot)
  safePath(source); safePath(root)
  if ((source === root && !options.inPlace) || source.startsWith(root + path.sep) || root.startsWith(source + path.sep))
    throw new Error('Migration directories must be separate')
  if (options.inPlace && source !== root) throw new Error('In-place upgrade requires the same directory')
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  const lock = path.join(root, '.qq-migration-lock'), fd = fs.openSync(lock, 'wx', 0o600)
  const marker = path.join(root, `data/${ID}/migration.json`)
  const journal = path.join(root, 'backups/qq-migration-transaction.json')
  try {
    const marked = bytes(marker)
    if (marked) {
      const previous = JSON.parse(marked.toString())
      if (previous.source !== source || previous.selfId !== trustedSelfId) throw new Error('Migration identity differs')
      return { completed: true, alreadyCompleted: true, report: previous.report }
    }
    const pending = bytes(journal)
    if (pending) {
      const previous = JSON.parse(pending.toString()) as Journal
      if (previous.source !== source || previous.selfId !== trustedSelfId) throw new Error('Incomplete migration identity differs')
      restore(root, previous)
      fs.unlinkSync(journal)
    }
    const backup = path.join(root, 'backups', `qq-migration-${randomUUID()}`)
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 })
    const candidates = new Map<string, Buffer>()
    const report: { code: string; fields?: string[] }[] = []
    const readBackup = (relative: string) => {
      const value = bytes(path.join(source, relative))
      if (value) {
        const target = path.join(backup, 'source', relative)
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
        fs.writeFileSync(target, value, { flag: 'wx', mode: 0o600 })
      }
      return value
    }
    const oldConfig = readBackup(`config/${ID}.json`)
    let config: z.infer<typeof QQConfigSchema>, revision = 1, state = emptyState()
    if (oldConfig) {
      const saved = z.object({ schemaVersion: z.literal(1), revision: z.number().int().nonnegative(), config: QQConfigSchema }).strict().parse(JSON.parse(oldConfig.toString()))
      config = saved.config; revision = saved.revision
      const oldState = readBackup(`data/${ID}/state.json`)
      if (oldState) state = StateSchema.parse(JSON.parse(oldState.toString()))
      readBackup('registry.json')
      if (config.selfId && config.selfId !== trustedSelfId) throw new Error('Legacy and trusted identities differ')
    } else {
      const bridge = readBackup('bridge.json')
      if (!bridge) throw new Error('Legacy bridge configuration is required')
      const old = z.object({ botId: z.union([QQIdSchema, z.literal('')]).optional(),
        groups: z.array(QQIdSchema), users: z.array(QQIdSchema), preset: z.string().optional() }).passthrough().parse(JSON.parse(bridge.toString()))
      if (old.botId && old.botId !== trustedSelfId) throw new Error('Legacy and trusted identities differ')
      const targets = [...old.groups.map(id => `group:${id}`), ...old.users.map(id => `private:user:${id}`)]
      const fields = ['continuationTtlMs', 'waitMessageMode', 'waitMessages', 'maxMessageChars', 'queueLimit', 'historyLimit']
      config = QQConfigSchema.parse({ ...QQDefaultConfig, selfId: trustedSelfId, groups: old.groups, users: old.users,
        bindings: old.preset ? Object.fromEntries(targets.map(target => [target, old.preset])) : {},
        ...Object.fromEntries(fields.filter(key => old[key] !== undefined).map(key => [key, old[key]])) })
      if (!old.preset && targets.length) report.push({ code: 'PRESET_BINDING_REQUIRED' })
      const differing = ['waitAfterMs', 'waitEveryMs'].filter(key => old[key] !== undefined && old[key] !== 30000)
      if (differing.length) { report.push({ code: 'WAIT_POLICY_CONFIRMATION_REQUIRED', fields: differing }); state.migrated.push({ state: 'paused', reason: 'WAIT_POLICY_CONFIRMATION_REQUIRED', fields: differing }) }
      readBackup('backend-settings.json')
      const oldState = readBackup('state.json')
      if (oldState) {
        const value = z.object({ jobs: z.array(z.record(z.string(), z.unknown())) }).passthrough().parse(JSON.parse(oldState.toString()))
        state.migrated.push({ state: 'paused', reason: 'LEGACY_STATE_REVIEW_REQUIRED', legacyState: value })
        if (value.jobs.some(job => !['done', 'failed'].includes(String(job.state)))) report.push({ code: 'LEGACY_TASKS_PAUSED' })
      }
    }
    for (const job of state.jobs) if (job.state === 'running') { job.state = 'paused'; job.reason = 'MIGRATION_REVIEW_REQUIRED'; delete job.nextWaitAt }
    for (const output of state.outbox) if (output.status === 'inflight') output.status = 'unknown'
    candidates.set(`config/${ID}.json`, Buffer.from(JSON.stringify({ schemaVersion: 1, revision, config })))
    candidates.set(`data/${ID}/state.json`, Buffer.from(JSON.stringify(StateSchema.parse(state))))
    if (options.memoryRoot) {
      const memoryRoot = path.resolve(options.memoryRoot)
      safePath(memoryRoot)
      for (const scope of ['personal', 'group', 'member'] as const) {
        const dir = path.join(memoryRoot, `qq-${scope}-memory`)
        safePath(dir)
        if (!fs.existsSync(dir)) continue
        if (!fs.lstatSync(dir).isDirectory()) throw new Error('Invalid memory directory')
        for (const name of fs.readdirSync(dir)) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Unexpected memory file')
          const value = bytes(path.join(dir, name))!
          const data = recordSchema.parse(JSON.parse(value.toString()))
          const identity = data.identity
          const key = scope === 'personal' ? identity.userId : scope === 'group' ? identity.groupId : `${identity.groupId}:${identity.userId}`
          if (!key || (scope === 'personal' ? identity.conversationType !== 'private' || !!identity.groupId : identity.conversationType !== 'group') ||
            (scope === 'member' && (!identity.groupId || !identity.userId)) || createHash('sha256').update(key).digest('hex') + '.json' !== name)
            throw new Error('Memory identity differs')
          const saved = path.join(backup, 'memory', scope, name)
          fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 })
          fs.writeFileSync(saved, value, { flag: 'wx', mode: 0o600 })
          candidates.set(`data/${ID}/memory/${scope}/${name}`, Buffer.from(JSON.stringify({ ...data, schemaVersion: 1, revision: data.revision ?? 0 })))
        }
      }
    }
    if (options.userFilesRoot) {
      const external = path.resolve(options.userFilesRoot)
      safePath(external)
      let total = 0, count = 0
      const copy = (dir: string, relative: string) => {
        safePath(dir)
        if (!fs.lstatSync(dir).isDirectory()) throw new Error('Invalid personal files directory')
        for (const name of fs.readdirSync(dir)) {
          const file = path.join(dir, name), sub = path.join(relative, name), stat = fs.lstatSync(file)
          if (stat.isSymbolicLink()) throw new Error('Symlink rejected')
          if (stat.isDirectory()) copy(file, sub)
          else {
            const value = bytes(file)!
            total += value.length; count++
            if (total > 25 * 1024 * 1024 || count > 10000) throw new Error('Personal files backup exceeds limit')
            const target = path.join(backup, 'user-files', sub)
            fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
            fs.writeFileSync(target, value, { flag: 'wx', mode: 0o600 })
          }
        }
      }
      copy(external, '')
      report.push({ code: 'EXTERNAL_PERSONAL_FILES_RETAINED' })
    }
    const references = z.array(z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/)).parse(options.credentialReferences ?? [])
    atomicJson(path.join(backup, 'credential-references.json'), references)
    fault?.('backed_up')
    const changes: Change[] = []
    for (const [name, value] of candidates) {
      const before = bytes(path.join(root, name))
      if (before && !options.inPlace) throw new Error('Refusing to overwrite current QQ data')
      changes.push({ name, before: before?.toString('base64') ?? null, after: hash(value) })
    }
    const transaction: Journal = { source, selfId: trustedSelfId, backup, changes }
    atomicJson(journal, transaction)
    try {
      for (const [name, value] of candidates) {
        atomicJson(path.join(root, name), JSON.parse(value.toString()))
        fault?.(name.endsWith('state.json') ? 'state_published' : name.startsWith('config/') ? 'config_published' : 'memory_published')
      }
      atomicJson(marker, { schemaVersion: 1, source, selfId: trustedSelfId, backup, report })
      fault?.('marked')
      fs.unlinkSync(journal)
    } catch (error) {
      if (!bytes(marker)) { restore(root, transaction); fs.unlinkSync(journal) }
      throw error
    }
    return { completed: true, alreadyCompleted: false, report }
  } finally { fs.closeSync(fd); fs.unlinkSync(lock) }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const inPlace = args[0] === '--in-place'
  if (inPlace) args.shift()
  const [source, root, selfId, memoryRoot, userFilesRoot] = args
  if (!source || !root || !selfId) { console.error('Usage: migrate.mjs [--in-place] <source> <ingress-root> <self-id> [memory-root] [personal-files-root]'); process.exitCode = 1 }
  else try { console.log(JSON.stringify(migrateQQ(source, root, selfId, undefined, { inPlace, memoryRoot, userFilesRoot }))) }
  catch { console.error('QQ migration failed; inspect transaction before retry. Existing data retained.'); process.exitCode = 1 }
}
