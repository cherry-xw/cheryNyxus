import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { readOidcConfig, saveOidcConfig, validateOidcInput } from '../src/authConfig.js'

describe('Manager OIDC configuration API helpers', () => {
  it('validates redirect origin and persists while exposing only secret state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manager-oidc-config-'))
    const file = join(root, 'config.yaml')
    try {
      await writeFile(file, 'manager:\n  auth:\n    trustedOrigins:\n      - https://manager.example\n')
      const input = { issuer: 'https://issuer.example', clientId: 'client', clientSecret: 'secret-value', redirectUri: 'https://manager.example/api/auth/oidc/callback', adminSubjects: ['admin'] }
      expect(validateOidcInput({ ...input, redirectUri: 'https://evil.example/api/auth/oidc/callback' }, ['https://manager.example']).errors).toContain('redirectUri_origin_untrusted')
      expect((await saveOidcConfig(file, input)).configured).toBe(true)
      const view = await readOidcConfig(file)
      expect(view).toMatchObject({ issuer: input.issuer, clientId: input.clientId, redirectUri: input.redirectUri, clientSecretConfigured: true, configured: true })
      expect(JSON.stringify(view)).not.toContain(input.clientSecret)
      expect(await readFile(file, 'utf8')).toContain('clientSecret: secret-value')
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})