import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'
import { hashPassword } from '../../apps/backend/src/utils/password.js'
import { AccountStore } from '../../apps/manager/src/accountStore.js'
import { BackendRpcClient } from '../../apps/manager/src/modules/capabilities/rpc.js'

const root = await mkdtemp(join(tmpdir(), 'nyxus-deployment-'))
const data = join(root, 'data')
const portBase = 20000 + (process.pid % 1000) * 4
await mkdir(join(data, '.chery'), { recursive: true, mode: 0o700 })
await mkdir(join(data, 'data'), { recursive: true, mode: 0o700 })
const password = 'synthetic-runtime-password'
let config = await readFile('apps/backend/deploy/docker/config.example.yaml', 'utf8')
config = config.replace(
  'enabled: false\n  remote:',
  `enabled: true\n    username: synthetic-owner\n    password: '${hashPassword(password)}'\n  remote:`,
)
await writeFile(join(data, '.chery/config.yaml'), config, { mode: 0o600 })
await new AccountStore(join(data, '.chery/manager-auth.json')).save('synthetic-owner', password)
const envFile = join(root, 'empty.env')
await writeFile(envFile, '', { mode: 0o600 })
const secretPaths: Record<string, string> = {}
for (const [key, name] of [
  ['CHERY_AUTH_SESSION_SECRET_FILE', 'session'],
  ['QQBOT_PLATFORM_TOKEN_FILE', 'qq'],
  ['QQBOT_MODEL_KEY_FILE', 'model'],
]) {
  const file = join(root, name)
  await writeFile(file, randomBytes(32).toString('hex'), { mode: 0o600 })
  secretPaths[key] = file
}
const env = {
  ...process.env,
  ...secretPaths,
  QQBOT_DATA_DIR: data,
  QQBOT_ENV_FILE: envFile,
  QQ_INGRESS_PAUSED: '1',
  NYXUS_WEB_PORT: String(portBase),
  NYXUS_MANAGER_PORT: String(portBase + 1),
  WEB_PORT: String(portBase + 2),
  QQBOT_RPC_PORT: String(portBase + 3),
  HTTP_PROXY: '',
  HTTPS_PROXY: '',
  ALL_PROXY: '',
}
const project = `nyxus-lane-6ff531e5-${process.pid}`
const args = [
  'compose',
  '-p',
  project,
  '-f',
  resolve('deployment/compose.yaml'),
  '--profile',
  'management',
]
const command = (...extra: string[]) =>
  execFileSync('docker', [...args, ...extra], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180000,
  }).toString()
const rpc = new BackendRpcClient({
  target: async () => ({
    http: `http://127.0.0.1:${env.WEB_PORT}`,
    ws: `ws://127.0.0.1:${env.QQBOT_RPC_PORT}`,
  }),
  credentials: async () => ({ username: 'synthetic-owner', password }),
})
console.log('Synthetic workspace:', root)
try {
  command(
    'run',
    '--rm',
    '--no-deps',
    'backend',
    'node',
    '/app/dist/index.js',
    'ingress',
    'install',
    '/app/opt/qq-plugin',
  )
  command(
    'run',
    '--rm',
    '--no-deps',
    'backend',
    'node',
    '/app/dist/index.js',
    'ingress',
    'enable',
    'cherynyxus-qq-module',
  )
  command('up', '-d', '--no-build', '--wait', '--wait-timeout', '90')
  console.log(command('ps'))
  assert.equal((await fetch(`http://127.0.0.1:${env.NYXUS_WEB_PORT}/`)).status, 200)
  assert.equal((await fetch(`http://127.0.0.1:${env.NYXUS_WEB_PORT}/api/config`)).status, 401)
  assert.equal((await fetch(`http://127.0.0.1:${env.NYXUS_MANAGER_PORT}/`)).status, 200)
  const status = await rpc.call('qq.status.get', {})
  console.log('QQ synthetic paused status:', JSON.stringify(status))
  assert.match(JSON.stringify(status), /paused|PAUSED/)
  const login = await fetch(`http://127.0.0.1:${env.NYXUS_MANAGER_PORT}/api/auth/login`, {
    method: 'POST',
    headers: {
      Origin: `http://127.0.0.1:${env.NYXUS_MANAGER_PORT}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username: 'synthetic-owner', password }),
  })
  assert.equal(login.status, 200)
  const Cookie = login.headers.get('set-cookie')!.split(';')[0]!
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${env.NYXUS_MANAGER_PORT}/api/backend/start`, {
        method: 'POST',
        headers: { Cookie, Origin: `http://127.0.0.1:${env.NYXUS_MANAGER_PORT}` },
      })
    ).status,
    409,
  )
  const registryFile = join(data, '.chery/ingress/registry.json')
  const registry = await readFile(registryFile, 'utf8')
  const account = await readFile(join(data, '.chery/manager-auth.json'), 'utf8')
  command('up', '-d', '--no-build', '--force-recreate', '--wait', '--wait-timeout', '90')
  assert.equal(await readFile(registryFile, 'utf8'), registry)
  assert.equal(await readFile(join(data, '.chery/manager-auth.json'), 'utf8'), account)
  const restored = await rpc.call('qq.status.get', {})
  assert.match(JSON.stringify(restored), /paused|PAUSED/)
  assert.equal((await stat(join(data, '.chery'))).mode & 0o777, 0o700)
  console.log(
    'PASS three real containers healthy, paused plugin active, auth enforced, external backend guarded, registry/account persistent after recreation',
  )
} catch (error) {
  console.log(command('logs', '--tail', '60', 'backend'))
  throw error
} finally {
  rpc.close()
  console.log(command('down', '--timeout', '10'))
  console.log('Synthetic data retained:', root)
}
