import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:net'
import { createManager } from '../src/server.js'
import { withBackendLifecycle } from './backendFixture.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action() })
async function fixture(command = process.execPath) {
  const root = await mkdtemp('/tmp/opencode/manager-pair-'); cleanup.push(() => rm(root, { recursive: true, force: true }))
  const configFile = join(root, 'config.yaml'); await writeFile(configFile, 'server:\n  port: 0\n  webPort: 0\n')
  const manager = createManager({ host: '127.0.0.1', port: 0, configFile, authFile: join(root, 'auth.json'), tokenFile: join(root, 'token.json'),
    backendCommand: command, backendArgs: ['-e', withBackendLifecycle('setInterval(()=>{},1000)')] })
  await manager.listen(); cleanup.push(() => manager.close())
  return { manager, root, configFile, base: `http://127.0.0.1:${manager.address()!.port}` }
}

it('listens first, starts one Backend, and keeps Manager available while Backend is stopped and restarted', async () => {
  const { manager, base } = await fixture()
  expect(manager.controller.isManaged('backend')).toBe(false)
  expect((await fetch(base + '/api/auth/capabilities')).status).toBe(200)
  const first = await manager.startBackend()
  expect(first?.running).toBe(true)
  expect((await manager.startBackend())?.pid).toBe(first?.pid)
  await manager.controller.stopExclusive('backend')
  expect((await fetch(base + '/api/auth/capabilities')).status).toBe(200)
  const second = await manager.startBackend()
  expect(second?.pid).not.toBe(first?.pid)
})

it('a Backend spawn failure does not close Manager or create credentials', async () => {
  const { manager, base, root } = await fixture('/not-a-real-backend-executable')
  await expect(manager.startBackend()).rejects.toThrow()
  expect((await fetch(base + '/api/auth/capabilities')).status).toBe(200)
  await expect(readFile(join(root, 'manager-credentials.json'))).rejects.toThrow()
})

it('refuses to start a second Backend when its configured port is occupied', async () => {
  const { manager, configFile } = await fixture()
  const listener = createServer()
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => listener.close(() => resolve())))
  const port = (listener.address() as { port: number }).port
  await writeFile(configFile, `server:\n  port: ${port}\n  webPort: 0\n`)
  await expect(manager.startBackend()).rejects.toThrow('端口已占用')
  expect(manager.controller.isManaged('backend')).toBe(false)
})

it.skipIf(process.platform === 'win32')('closing Manager cleans the complete owned Backend process group', async () => {
  const { manager, root } = await fixture()
  const pidFile = join(root, 'child.pid')
  const child = manager.controller.start('backend', process.execPath, ['-e', `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000)`])
  let descendant = 0
  await vi.waitFor(async () => { descendant = Number(await readFile(pidFile, 'utf8')); expect(descendant).toBeGreaterThan(0) })
  await manager.close()
  await vi.waitFor(() => { expect(() => process.kill(child.pid!, 0)).toThrow(); expect(() => process.kill(descendant, 0)).toThrow() })
  await expect(manager.startBackend()).rejects.toThrow('正在关闭')
})
