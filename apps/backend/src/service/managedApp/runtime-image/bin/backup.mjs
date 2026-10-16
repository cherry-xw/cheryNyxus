import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

// The controller runs this fixed entry as the supervised container user.
export function snapshotApplication(id, dataRoot = '/data', projectRoot = '/workspace') {
  if (!/^bak_\d+$/.test(id ?? '')) throw new Error('Invalid backup id')
  const root = path.join(dataRoot, `.backup-${id}`)
  fs.mkdirSync(root, { recursive: false })
  try {
    fs.mkdirSync(path.join(root, 'data'))
    for (const name of fs.readdirSync(dataRoot)) {
      if (name.startsWith('.backup-') || /^\.bak_\d+\.tar\.gz$/.test(name) || ['app.sqlite', 'app.sqlite-wal', 'app.sqlite-shm'].includes(name)) continue
      fs.cpSync(path.join(dataRoot, name), path.join(root, 'data', name), { recursive: true, dereference: false })
    }
    fs.cpSync(projectRoot, path.join(root, 'project'), {
      recursive: true, dereference: false,
      filter: source => !['node_modules', '.git'].includes(path.basename(source)),
    })
    if (fs.existsSync(path.join(dataRoot, 'app.sqlite'))) {
      const db = new DatabaseSync(path.join(dataRoot, 'app.sqlite'))
      try {
        const destination = path.join(root, 'data', 'app.sqlite').replaceAll("'", "''")
        db.exec(`VACUUM INTO '${destination}'`)
      } finally { db.close() }
    }
    return root
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true })
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) snapshotApplication(process.argv[2])
