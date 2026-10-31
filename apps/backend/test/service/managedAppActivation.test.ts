import { describe, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
// @ts-expect-error The fixed application template is shipped as JavaScript.
import { ACTIVATION_TTL_MS, clearActivationToken, ensureActivationToken, pendingActivationToken, validActivationToken } from '../../src/service/managedApp/runtime-image/template/server/activation.mjs'

async function fixture(file = ':memory:') {
  const db = new DatabaseSync(file)
  db.exec(await readFile(new URL('../../src/service/managedApp/runtime-image/template/migrations/001_init.sql', import.meta.url), 'utf8'))
  return db
}

describe('managed app activation lifetime', () => {
  const issuedAt = Date.parse('2026-10-26T12:00:00+08:00')

  it('accepts only the issued token and expires at exactly thirty minutes', async () => {
    const db = await fixture()
    try {
      const token = ensureActivationToken(db, issuedAt)
      expect(ACTIVATION_TTL_MS).toBe(30 * 60 * 1000)
      expect(validActivationToken(db, token, issuedAt)).toBe(true)
      expect(validActivationToken(db, token, issuedAt + ACTIVATION_TTL_MS - 1)).toBe(true)
      expect(validActivationToken(db, token, issuedAt + ACTIVATION_TTL_MS)).toBe(false)
      expect(validActivationToken(db, 'wrong-token', issuedAt)).toBe(false)
      expect(validActivationToken(db, undefined, issuedAt)).toBe(false)
      expect(validActivationToken(db, token, issuedAt - 1)).toBe(false)
    } finally { db.close() }
  })

  it('does not renew the deadline when reading, rejecting or reopening the database', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'managed-activation-'))
    const file = path.join(root, 'app.sqlite')
    let db = await fixture(file)
    try {
      const token = ensureActivationToken(db, issuedAt)
      db.close()
      db = new DatabaseSync(file)
      expect(ensureActivationToken(db, issuedAt + 1)).toBe(token)
      expect(validActivationToken(db, 'wrong-token', issuedAt + 2)).toBe(false)
      expect(pendingActivationToken(db, issuedAt + ACTIVATION_TTL_MS)).toBeNull()
      expect(db.prepare("SELECT updated_at FROM app_kv WHERE key = 'activation_token_plain'").get()?.updated_at).toBe(issuedAt)
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('rotates an expired token only when explicitly issuing another', async () => {
    const db = await fixture()
    try {
      const old = ensureActivationToken(db, issuedAt)
      const expiredAt = issuedAt + ACTIVATION_TTL_MS
      expect(pendingActivationToken(db, expiredAt)).toBeNull()
      expect(validActivationToken(db, old, expiredAt)).toBe(false)
      const renewed = ensureActivationToken(db, expiredAt)
      expect(renewed).not.toBe(old)
      expect(validActivationToken(db, old, expiredAt)).toBe(false)
      expect(validActivationToken(db, renewed, expiredAt)).toBe(true)
    } finally { db.close() }
  })

  it('removes both token records on consumption and never issues after activation', async () => {
    const db = await fixture()
    try {
      const token = ensureActivationToken(db, issuedAt)
      db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run('admin', 'test-only', 'owner', issuedAt)
      clearActivationToken(db)
      expect(db.prepare("SELECT COUNT(*) as cnt FROM app_kv WHERE key LIKE 'activation_token_%'").get()?.cnt).toBe(0)
      expect(validActivationToken(db, token, issuedAt)).toBe(false)
      expect(ensureActivationToken(db, issuedAt + 1)).toBeNull()
    } finally { db.close() }
  })

  it.each(['activation_token_hash', 'activation_token_plain'])('rejects an incomplete token record: %s', async key => {
    const db = await fixture()
    try {
      const token = ensureActivationToken(db, issuedAt)
      db.prepare('DELETE FROM app_kv WHERE key = ?').run(key)
      expect(validActivationToken(db, token, issuedAt)).toBe(false)
    } finally { db.close() }
  })

  it('rejects mismatched hashes and timestamps', async () => {
    const db = await fixture()
    try {
      const token = ensureActivationToken(db, issuedAt)
      db.prepare("UPDATE app_kv SET updated_at = ? WHERE key = 'activation_token_hash'").run(issuedAt + 1)
      expect(validActivationToken(db, token, issuedAt + 1)).toBe(false)
      db.prepare("UPDATE app_kv SET updated_at = ?, value = 'wrong' WHERE key = 'activation_token_hash'").run(issuedAt)
      expect(validActivationToken(db, token, issuedAt)).toBe(false)
    } finally { db.close() }
  })
})

it('uses the exact project name in the shipped template', async () => {
  const template = await readFile(new URL('../../src/service/managedApp/runtime-image/template/src/App.vue', import.meta.url), 'utf8')
  expect(template.match(/cherynyxus/gi)).toEqual(['cheryNyxus'])
})
