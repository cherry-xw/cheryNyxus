import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'

it.each(['missing', 'invalid'] as const)('starts the actual Manager entry without provisioning %s Backend credentials', async failure => {
  const root = await mkdtemp(join(tmpdir(), 'manager-entry-independent-'))
  const directory = join(root, '.chery'), config = join(directory, 'config.yaml'), credentials = join(directory, 'manager-credentials.json')
  await mkdir(directory)
  const original = 'server:\n  auth:\n    username: business\n    password: untouched\nmanager:\n  backendPlugin:\n    autoStart: false\n'
  await writeFile(config, original)
  if (failure === 'invalid') await writeFile(credentials, '{invalid-credentials')
  const child = spawn(process.execPath, ['--import', 'tsx', resolve('apps/manager/src/index.ts')], {
    env: { ...process.env, CHERY_DIR: root, CHERY_ENV_FILE: join(root, 'absent.env'), DB_DIR: join(root, 'db'), CHERY_MANAGER_BACKEND_MODE: 'external', CHERY_MANAGER_HOST: '127.0.0.1', CHERY_MANAGER_PORT: '0', CHERY_MANAGER_TOKEN: 'synthetic-entry-key' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = '', error = ''
  child.stdout.on('data', chunk => { output += chunk.toString() })
  child.stderr.on('data', chunk => { error += chunk.toString() })
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Manager startup not observed: ${error}`)), 10_000)
      const onData = () => {
        if (output.includes('manager_backend_autostart')) { clearTimeout(timer); child.stdout.off('data', onData); resolve() }
      }
      child.stdout.on('data', onData)
      child.once('error', reject)
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`Manager exited before listening: ${error}`)) })
      onData()
    })
    expect(output).toContain('manager_listening')
    expect(output).toContain('external_mode')
    expect(await readFile(config, 'utf8')).toBe(original)
    if (failure === 'invalid') expect(await readFile(credentials, 'utf8')).toBe('{invalid-credentials')
    else await expect(readFile(credentials)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(credentials + '.key')).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await exited
    await rm(root, { recursive: true, force: true })
  }
})
