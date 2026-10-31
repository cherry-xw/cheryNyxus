import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateLegacyQQSources } from './sourceMigration.js'

const hashFile = (file: string) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** Standalone maintenance: no config, services, plugin loading or model initialization. */
export function runSourceMigrationCommand(args: readonly string[]) {
  const options = new Map<string, string>()
  let stopped = false
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!
    if (key === '--stopped') { if (stopped) throw new Error('INVALID_ARGUMENTS'); stopped = true; continue }
    if (!['--db', '--data-dir', '--mode', '--backup-dir', '--recovery-manifest', '--assets-dir'].includes(key) || options.has(key)) throw new Error('INVALID_ARGUMENTS')
    const value = args[++index]
    if (!value || value.startsWith('--')) throw new Error('INVALID_ARGUMENTS')
    options.set(key, value)
  }
  const mode = options.get('--mode') ?? 'dry-run'
  if (!['dry-run', 'apply'].includes(mode)) throw new Error('INVALID_ARGUMENTS')
  const absolute = (key: string) => {
    const value = options.get(key)
    if (!value || !path.isAbsolute(value)) throw new Error('ABSOLUTE_PATH_REQUIRED')
    return path.resolve(value)
  }
  const database = absolute('--db'), dataDir = absolute('--data-dir')
  if (mode === 'apply') {
    if (!stopped) throw new Error('STOPPED_BACKEND_REQUIRED')
    const manifest = JSON.parse(fs.readFileSync(absolute('--recovery-manifest'), 'utf8')) as {
      files?: { originalPath: string; backupPath: string; sha256: string }[]
    }
    if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('RECOVERY_BACKUP_INVALID')
    const files = new Map<string, string>()
    for (const item of manifest.files) {
      if (!path.isAbsolute(item.originalPath) || !path.isAbsolute(item.backupPath) || !/^[a-f0-9]{64}$/.test(item.sha256) ||
        item.originalPath === item.backupPath || files.has(path.resolve(item.originalPath)) ||
        hashFile(item.backupPath) !== item.sha256) throw new Error('RECOVERY_BACKUP_INVALID')
      files.set(path.resolve(item.originalPath), item.sha256)
    }
    const verify = (location: string) => {
      const stat = fs.lstatSync(location)
      if (stat.isSymbolicLink()) throw new Error('RECOVERY_BACKUP_INVALID')
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(location)) verify(path.join(location, entry))
      } else if (!stat.isFile() || files.get(location) !== hashFile(location)) throw new Error('RECOVERY_BACKUP_INCOMPLETE')
    }
    // The offline snapshot must include the main/monthly databases, QQ state and assets.
    verify(path.dirname(database)); verify(dataDir); verify(absolute('--assets-dir'))
    absolute('--backup-dir')
  }
  const db = new Database(database, { readonly: mode !== 'apply', fileMustExist: true })
  try {
    return migrateLegacyQQSources({ db, dataDir, mode: mode as 'dry-run' | 'apply',
      ...(options.has('--backup-dir') ? { backupDir: absolute('--backup-dir') } : {}) })
  } finally { db.close() }
}
