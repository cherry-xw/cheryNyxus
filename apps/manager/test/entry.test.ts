import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { AccountStore } from '../src/accountStore.js'

it('exercises manager:dev entry without backend and never logs a URL credential', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'manager-entry-'))
  await mkdir(join(dir, '.chery'))
  await writeFile(join(dir, '.chery/config.yaml'), 'server:\n  port: 1\n  webPort: 1\n')
  await new AccountStore(join(dir, '.chery/manager-auth.json')).save('owner', 'manager-test-password')
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/manager/src/index.ts'], {
    // 与 manager:dev 脚本一致：从仓库根目录解析相对入口路径。
    cwd: resolve(import.meta.dirname, '../../..'),
    env: { ...process.env, CHERY_DIR: dir, CHERY_MANAGER_HOST: '127.0.0.1', CHERY_MANAGER_PORT: '0', CHERY_MANAGER_TOKEN: 'entry-machine-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', errors = ''
  child.stderr.on('data', (chunk) => { errors += String(chunk) })
  try {
    const base = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('entry startup timed out')), 10000)
      child.once('error', (error) => { clearTimeout(timer); reject(error) })
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`entry exited: ${errors}`)) })
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
        const line = output.split('\n').find((value) => value.startsWith('{"event":"manager_listening"'))
        if (line) { clearTimeout(timer); resolve((JSON.parse(line) as { url: string }).url.replace(/\/$/, '')) }
      })
    })
    expect(output).not.toContain('entry-machine-key')
    expect(output).not.toContain('token=')
    expect((await fetch(`${base}/api/status`)).status).toBe(401)
    const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'owner', password: 'manager-test-password' }) })
    expect(login.status).toBe(200)
    const Cookie = login.headers.get('set-cookie')!.split(';')[0]!
    expect((await fetch(`${base}/api/status`, { headers: { Cookie } })).status).toBe(200)
    expect((await fetch(`${base}/api/machine/status`, { headers: { 'X-Chery-Manager-Machine-Key': 'entry-machine-key' } })).status).toBe(200)
  } finally {
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    await rm(dir, { recursive: true, force: true })
  }
})
