import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = () =>
  readFile(resolve(new URL('.', import.meta.url).pathname, '../ui/App.vue'), 'utf8')

describe('Manager login and OIDC UI contract', () => {
  it('keeps password login primary and gates OIDC by backend capability', async () => {
    const text = await source()
    expect(text).toContain('使用用户名密码登录')
    expect(text).toContain("'/api/auth/capabilities'")
    expect(text).toContain('!oidcAvailable')
    expect(text).toContain("window.location.assign('/api/auth/oidc/login')")
  })

  it('exposes all protected OIDC fields without rendering or storing the secret', async () => {
    const text = await source()
    for (const field of ['issuer', 'clientId', 'redirectUri'])
      expect(text).toContain(`oidc.${field}`)
    expect(text).toContain('v-model="oidcSubjectsText"')
    expect(text).toMatch(/adminSubjects:\s*oidcSubjectsText\.value\s*\.split\('\\n'\)/)
    expect(text).toContain('type="password"')
    expect(text).toContain('clientSecretConfigured')
    expect(text).toContain('clientSecret: oidcSecret.value')
    expect(text).not.toContain('localStorage')
  })

  it('reports restart requirement after backend save and rereads the response', async () => {
    const text = await source()
    expect(text).toContain("'/api/auth/oidc/config'")
    expect(text).toContain('result.restartRequired')
    expect(text).toContain('已保存并回读确认')
  })

  it('renders the one-time account setup only when backend capabilities allow it', async () => {
    const text = await source()
    expect(text).toContain("'/api/auth/capabilities'")
    expect(text).toContain("'/api/auth/setup'")
    expect(text).toContain('firstAccountAllowed')
    expect(text).toContain('accountInitialized')
    expect(text).toContain('firstAccountPasswordConfirmation')
    expect(text).toContain('type="password"')
    expect(text).not.toContain('localStorage')
    expect(text).not.toContain('sessionStorage')
  })
})
