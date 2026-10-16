import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DATA_DIR = process.env.DATA_DIR || '/data'
const DB_PATH = path.join(DATA_DIR, 'app.sqlite')
const MIGRATIONS_DIR = path.resolve(process.cwd(), 'migrations')

let dbInstance = null

export function getDb() {
  if (dbInstance) return dbInstance
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const db = new DatabaseSync(DB_PATH)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec('PRAGMA busy_timeout = 5000;')
  dbInstance = db
  return db
}

export function runMigrations(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `)

  if (!fs.existsSync(MIGRATIONS_DIR)) return []

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort()

  const appliedStmt = db.prepare('SELECT version FROM _migrations WHERE version = ?')
  const insertStmt = db.prepare(
    'INSERT INTO _migrations (version, applied_at) VALUES (?, ?)',
  )

  const newlyApplied = []
  for (const file of files) {
    const existing = appliedStmt.get(file)
    if (existing) continue

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    db.exec('BEGIN IMMEDIATE;')
    try {
      db.exec(sql)
      insertStmt.run(file, Date.now())
      db.exec('COMMIT;')
      newlyApplied.push(file)
    } catch (err) {
      db.exec('ROLLBACK;')
      throw err
    }
  }
  return newlyApplied
}
