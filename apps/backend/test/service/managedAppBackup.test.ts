import { describe, it, expect } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, lstat } from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
// @ts-expect-error Fixed runtime entry is shipped as JavaScript.
import { snapshotApplication } from '../../src/service/managedApp/runtime-image/bin/backup.mjs'

describe('managed app SQLite backup', () => {
  it('restores committed WAL data, attachments and project without copying dependencies or following symlinks', async () => {
    const root = await mkdtemp(path.join(process.env.TMPDIR!, 'app-backup-'))
    const data = path.join(root, 'data'), project = path.join(root, 'project')
    await mkdir(data); await mkdir(project)
    const db = new DatabaseSync(path.join(data, 'app.sqlite'))
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE items (value TEXT); INSERT INTO items VALUES ('saved')")
      await writeFile(path.join(data, 'attachment.txt'), 'attachment')
      await writeFile(path.join(project, 'index.mjs'), 'source')
      await mkdir(path.join(project, 'node_modules'))
      await writeFile(path.join(project, 'node_modules', 'excluded'), 'dependency')
      await symlink(path.join(root, 'outside'), path.join(project, 'link'))
      const snapshot = snapshotApplication('bak_123', data, project)
      const restored = new DatabaseSync(path.join(snapshot, 'data', 'app.sqlite'))
      try { expect(restored.prepare('SELECT value FROM items').get()).toEqual({ value: 'saved' }) } finally { restored.close() }
      expect(await readFile(path.join(snapshot, 'data', 'attachment.txt'), 'utf8')).toBe('attachment')
      expect(await readFile(path.join(snapshot, 'project', 'index.mjs'), 'utf8')).toBe('source')
      expect((await lstat(path.join(snapshot, 'project', 'link'))).isSymbolicLink()).toBe(true)
      await expect(lstat(path.join(snapshot, 'project', 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(path.join(snapshot, 'data', 'app.sqlite-wal'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(() => snapshotApplication('../escape', data, project)).toThrow('Invalid backup id')
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
  })
})
