import { describe, expect, it } from 'vitest'
import { parseActiveConnection } from '../../src/domain/auth/activeConnection'
const origin = 'http://10.2.3.6:8183'
const summary = { schemaVersion: 1, revision: 2, status: 'active', origin, basePath: '/nyxus', backendId: 'home-nyxus', displayIdentity: 'user' }
describe('safe connection summary', () => {
  it('allows safe same-origin display data and explicit locked states', () => {
    for (const status of ['active', 'switching', 'signed-out', 'locked']) expect(parseActiveConnection(JSON.stringify({ ...summary, status }), origin)?.status).toBe(status)
  })
  it('rejects unsafe origins, paths, secrets and old formats', () => {
    for (const item of [{ ...summary, origin: 'https://evil.example' }, { ...summary, basePath: '//evil.example' }, { ...summary, basePath: '/%2e%2e' }, { ...summary, basePath: '/a/../b' }, { ...summary, accessToken: 'secret' }, { ...summary, schemaVersion: 0 }, { ...summary, revision: -1 }]) expect(parseActiveConnection(JSON.stringify(item), origin)).toBeNull()
  })
})
