import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { describe, expect, it, vi } from 'vitest'
import yaml from 'js-yaml'
import { AccountStore } from '../src/accountStore.js'
import { CredentialStore } from '../src/credentials.js'
import { createManager } from '../src/server.js'
import { managerRequest } from '../../../packages/manager-ui/src/api.js'

describe('t_caadc513 backend failures must not expire Manager sessions', () => {
  for (const mode of ['missing', 'denied', 'offline'] as const) {
    it(`valid Session with ${mode} backend remains authenticated`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'manager-auth-boundary-'))
      const backend = createServer((_req, res) => {
        res.writeHead(401)
        res.end('synthetic rejection')
      })
      await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve))
      const port = (backend.address() as AddressInfo).port
      if (mode === 'offline') await new Promise<void>((resolve) => backend.close(() => resolve()))
      const configFile = join(root, 'config.yaml')
      const credentialsFile = join(root, 'credentials.json')
      const authFile = join(root, 'auth.json')
      await writeFile(configFile, yaml.dump({ server: { host: '127.0.0.1', port, webPort: port } }))
      if (mode !== 'missing')
        await new CredentialStore({ configFile, credentialsFile }).rotate({
          username: 'synthetic-backend',
          password: 'synthetic-backend-password',
        })
      await new AccountStore(authFile).save('synthetic-owner', 'synthetic-manager-password')
      const manager = createManager({
        port: 0,
        configFile,
        credentialsFile,
        authFile,
        tokenFile: join(root, 'machine.json'),
        controlToken: 'synthetic-machine-key',

      })
      try {
        await manager.listen()
        const base = `http://127.0.0.1:${manager.address()!.port}`
        const login = await fetch(base + '/api/auth/login', {
          method: 'POST',
          headers: { Origin: base, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: 'synthetic-owner',
            password: 'synthetic-manager-password',
          }),
        })
        expect(login.status).toBe(200)
        const cookie = login.headers.get('set-cookie')!.split(';')[0]!
        const statuses: number[] = []
        for (const endpoint of ['/api/modules/qq/config', '/api/modules/capabilities/catalog']) {
          expect((await fetch(base + endpoint)).status).toBe(401)
          expect(
            (await fetch(base + endpoint, { headers: { Cookie: 'chery-manager-session=invalid' } }))
              .status,
          ).toBe(401)
          const response = await fetch(base + endpoint, { headers: { Cookie: cookie } })
          statuses.push(response.status)
          expect(response.status).toBe(mode === 'offline' ? 503 : 502)
          expect(await response.json()).toMatchObject({
            error: { code: mode === 'offline' ? 'unavailable' : 'backend_auth_failed' },
          })
        }

        const expectedError = {
          code: mode === 'offline' ? 'unavailable' : 'backend_auth_failed',
          status: mode === 'offline' ? 503 : 502,
        }
        const nativeFetch = globalThis.fetch
        // Prefix only relative paths: the Manager server's own outbound fetch to the
        // Backend must keep its absolute URL, or this stub would break it in-process.
        const requester = ((endpoint: string | URL | Request, init?: RequestInit) =>
          typeof endpoint === 'string' && endpoint.startsWith('/')
            ? nativeFetch(base + endpoint, { ...init, headers: { ...init?.headers, Cookie: cookie } })
            : nativeFetch(endpoint as string, init)) as typeof fetch
        vi.stubGlobal('fetch', requester)
        try {
          await expect(managerRequest('/api/modules/qq/config')).rejects.toMatchObject(expectedError)
          await expect(managerRequest('/api/modules/capabilities/catalog')).rejects.toMatchObject(expectedError)
        } finally { vi.stubGlobal('fetch', nativeFetch) }
        // The built-in workspace remains accessible; dynamic pages require Backend.
        expect((await fetch(base + '/', { headers: { Cookie: cookie } })).status).toBe(200)
        expect.soft(statuses).not.toContain(401)
        vi.stubGlobal('fetch', ((endpoint: string | URL | Request) =>
          typeof endpoint === 'string' && endpoint.startsWith('/')
            ? nativeFetch(base + endpoint)
            : nativeFetch(endpoint as string)) as typeof fetch)
        try {
          await expect(managerRequest('/api/modules/qq/config')).rejects.toMatchObject({ code: 'unauthorized', status: 401 })
        } finally { vi.stubGlobal('fetch', nativeFetch) }

      } finally {
        await manager.close()
        if (backend.listening) await new Promise<void>((resolve) => backend.close(() => resolve()))
        await rm(root, { recursive: true, force: true })
      }
    })
  }
})
