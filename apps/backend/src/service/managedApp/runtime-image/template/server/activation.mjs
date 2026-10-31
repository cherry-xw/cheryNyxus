import crypto from 'node:crypto'

export const ACTIVATION_TTL_MS = 30 * 60 * 1000

function hashToken(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex')
}

export function pendingActivationToken(db, now = Date.now()) {
  if (Number(db.prepare('SELECT COUNT(*) as cnt FROM users').get()?.cnt || 0) > 0) return null
  const plain = db.prepare("SELECT value, updated_at FROM app_kv WHERE key = 'activation_token_plain'").get()
  const hash = db.prepare("SELECT value, updated_at FROM app_kv WHERE key = 'activation_token_hash'").get()
  const issuedAt = Number(plain?.updated_at)
  if (!plain?.value || !hash?.value || !Number.isFinite(issuedAt) ||
      issuedAt !== Number(hash.updated_at) || now < issuedAt || now >= issuedAt + ACTIVATION_TTL_MS ||
      hashToken(plain.value) !== hash.value) return null
  return plain.value
}

export function ensureActivationToken(db, now = Date.now()) {
  if (Number(db.prepare('SELECT COUNT(*) as cnt FROM users').get()?.cnt || 0) > 0) return null
  const existing = pendingActivationToken(db, now)
  if (existing) return existing
  const token = crypto.randomBytes(24).toString('base64url')
  db.exec('BEGIN IMMEDIATE;')
  try {
    const insert = db.prepare('INSERT OR REPLACE INTO app_kv (key, value, updated_at) VALUES (?, ?, ?)')
    insert.run('activation_token_hash', hashToken(token), now)
    insert.run('activation_token_plain', token, now)
    db.exec('COMMIT;')
  } catch (error) {
    db.exec('ROLLBACK;')
    throw error
  }
  return token
}

export function validActivationToken(db, raw, now = Date.now()) {
  const pending = pendingActivationToken(db, now)
  return typeof raw === 'string' && pending !== null &&
    crypto.timingSafeEqual(Buffer.from(hashToken(raw), 'hex'), Buffer.from(hashToken(pending), 'hex'))
}

export function clearActivationToken(db) {
  db.prepare("DELETE FROM app_kv WHERE key IN ('activation_token_hash', 'activation_token_plain')").run()
}
