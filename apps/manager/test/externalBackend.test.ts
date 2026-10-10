import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { createManager } from '../src/server.js'
import { AccountStore } from '../src/accountStore.js'

describe('externally managed backend', () => {
  it('rejects browser and machine start/stop/restart without spawning a backend', async () => {
    const root = await mkdtemp(join(tmpdir(), 'manager-external-'))
    const authFile = join(root, 'auth.json')
    const configFile = join(root, 'config.yaml')
    await new AccountStore(authFile).save('owner', 'synthetic-password-123')
    await writeFile(configFile, 'server:\n  host: 127.0.0.1\n  port: 1\n  webPort: 1\n')
    const manager = createManager({
      backendMode: 'external',
      port: 0,

      authFile,
      configFile,
      tokenFile: join(root, 'token.json'),
      credentialsFile: join(root, 'credentials.json'),
      controlToken: 'synthetic-machine-key',
    })
    try {
      await manager.listen()
      const base = `http://127.0.0.1:${manager.address()!.port}`
      const login = await fetch(base + '/api/auth/login', {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'owner', password: 'synthetic-password-123' }),
      })
      expect(login.status).toBe(200)
      const Cookie = login.headers.get('set-cookie')!.split(';')[0]!
      for (const action of ['start', 'stop', 'restart']) {
        for (const machine of [false, true]) {
          const response = await fetch(
            `${base}/api/${machine ? 'machine/' : ''}backend/${action}`,
            {
              method: 'POST',
              headers: machine
                ? { 'X-Chery-Manager-Machine-Key': 'synthetic-machine-key' }
                : { Cookie, Origin: base },
            },
          )
          expect(response.status).toBe(409)
          expect(await response.json()).toMatchObject({
            error: { code: 'backend_externally_managed' },
          })
        }
      }
      expect(manager.controller.isManaged('backend')).toBe(false)
      expect((await fetch(base + '/api/status', { headers: { Cookie } })).status).toBe(200)
    } finally {
      await manager.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
