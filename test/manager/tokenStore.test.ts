/**
 * Manager 管理密钥持久化 / 轮换 / 宽限单测：loadOrCreateToken / isTokenValid。
 * 用临时目录隔离，避免污染真实 .chery/。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import {
  isTokenValid,
  loadOrCreateToken,
  TOKEN_GRACE_MS,
} from '../../manager/src/tokenStore.js'

function tempFile(): string {
  const root = mkdtempSync(join(tmpdir(), 'chery-manager-token-'))
  return join(root, 'manager-token.json')
}

const DAY = 24 * 60 * 60 * 1000

describe('loadOrCreateToken', () => {
  it('creates a token file on first run and reuses it on later runs', () => {
    const file = tempFile()
    const first = loadOrCreateToken(file)
    const second = loadOrCreateToken(file)
    expect(second.token).toBe(first.token)
    expect(first.previous).toBeNull()
  })

  it('uses the explicit token without touching the file', () => {
    const file = tempFile()
    const state = loadOrCreateToken(file, 'explicit-token')
    expect(state.token).toBe('explicit-token')
    expect(state.previous).toBeNull()
  })

  it('rotates an expired token and keeps the old one within grace', () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        token: 'old-token',
        createdAt: new Date(Date.now() - 8 * DAY).toISOString(),
        previous: null,
      }),
    )
    const rotated = loadOrCreateToken(file)
    expect(rotated.token).not.toBe('old-token')
    expect(rotated.previous?.token).toBe('old-token')
    expect(isTokenValid(rotated, 'old-token')).toBe(true)
  })

  it('does not rotate a fresh token', () => {
    const file = tempFile()
    writeFileSync(
      file,
      JSON.stringify({
        token: 'fresh-token',
        createdAt: new Date().toISOString(),
        previous: null,
      }),
    )
    expect(loadOrCreateToken(file).token).toBe('fresh-token')
  })

  it('treats a corrupt file as missing', () => {
    const file = tempFile()
    writeFileSync(file, 'not json')
    const state = loadOrCreateToken(file)
    expect(state.token).toBeTruthy()
  })
})

describe('isTokenValid', () => {
  it('accepts the current token and rejects unknown or empty ones', () => {
    const state = {
      token: 'current',
      createdAt: new Date().toISOString(),
      previous: null,
    }
    expect(isTokenValid(state, 'current')).toBe(true)
    expect(isTokenValid(state, 'other')).toBe(false)
    expect(isTokenValid(state, undefined)).toBe(false)
    expect(isTokenValid(state, '')).toBe(false)
  })

  it('accepts the previous token only within the grace window', () => {
    const state = {
      token: 'current',
      createdAt: new Date().toISOString(),
      previous: { token: 'previous', rotatedAt: new Date().toISOString() },
    }
    expect(isTokenValid(state, 'previous')).toBe(true)

    const expired = {
      token: 'current',
      createdAt: new Date().toISOString(),
      previous: {
        token: 'previous',
        rotatedAt: new Date(Date.now() - TOKEN_GRACE_MS - 1000).toISOString(),
      },
    }
    expect(isTokenValid(expired, 'previous')).toBe(false)
  })
})
