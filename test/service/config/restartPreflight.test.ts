import fs from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { getSavedBaseRevision } from '@/service/config/commit.js'
import { validateRestartCandidate } from '@/service/config/restartPreflight.js'

it('rejects a later edit and invalid YAML without restoring a backup or changing disk', () => {
  const filename = path.join(process.env.CHERY_DIR!, '.chery/config.yaml')
  const original = fs.readFileSync(filename, 'utf8')
  const revision = getSavedBaseRevision()
  expect(validateRestartCandidate(revision)).toEqual({ ok: true })
  try {
    const later = `${original}\nrestart_test_unknown: true\n`
    fs.writeFileSync(filename, later)
    expect(validateRestartCandidate(revision).ok).toBe(false)
    expect(fs.readFileSync(filename, 'utf8')).toBe(later)
    fs.writeFileSync(filename, 'broken: [')
    expect(() => validateRestartCandidate(revision)).toThrow()
    expect(fs.readFileSync(filename, 'utf8')).toBe('broken: [')
  } finally {
    fs.writeFileSync(filename, original)
  }
  expect(validateRestartCandidate(revision)).toEqual({ ok: true })
})
