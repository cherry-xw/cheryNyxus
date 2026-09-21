import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createManager } from '../../manager/src/server.js'

describe('local manager', () => {
  it('keeps credential mutation loopback and token protected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-'))
    const configFile = join(root, 'config.yaml')
    const credentialsFile = join(root, 'manager-credentials.json')
    await writeFile(configFile, 'server:\n  port: 8182\n  webPort: 8183\n')
    const manager = createManager({
      host: '127.0.0.1',
      port: 0,
      controlToken: 'test-token',
      configFile,
      credentialsFile,
      backendCommand: process.execPath,
      backendArgs: ['-e', 'setTimeout(() => {}, 10000)'],
    })
    await manager.listen()
    const base = `http://127.0.0.1:${manager.address()!.port}`
    try {
      const unauthorized = await fetch(`${base}/api/credentials`)
      expect(unauthorized.status).toBe(401)

      const rotated = await fetch(`${base}/api/credentials/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Chery-Manager-Token': 'test-token' },
        body: JSON.stringify({ username: 'admin', password: 'test-password' }),
      })
      expect(rotated.status).toBe(200)
      const body = await rotated.json() as { credentials: { username: string; consistent: boolean } }
      expect(body.credentials).toMatchObject({ username: 'admin', consistent: true })
      expect(JSON.parse(await readFile(credentialsFile, 'utf8'))).toMatchObject({
        username: 'admin',
        password: 'test-password',
      })
      expect((await readFile(configFile, 'utf8'))).toContain('username: admin')
    } finally {
      await manager.close()
    }
  })
})
