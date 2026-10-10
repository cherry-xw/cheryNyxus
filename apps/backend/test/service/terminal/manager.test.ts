import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
const received: Array<{
  data: { sessionId: string; event: string; data?: string; code?: number }
}> = []
const callbacks = vi.hoisted(() => ({ onClose: (_owner: string) => {} }))
vi.mock('@/service/websocket/connection.js', () => ({
  connectionManager: {
    getWsByConnectionId: (id: string) =>
      id === 'owner'
        ? {
            readyState: 1,
            bufferedAmount: 0,
            send: (text: string) => received.push(JSON.parse(text)),
          }
        : undefined,
    onClose: (fn: typeof callbacks.onClose) => {
      callbacks.onClose = fn
    },
  },
}))
vi.mock('@/service/websocket/transport.js', () => ({ transport: { encode: JSON.stringify } }))
vi.mock('@/service/workspace/sandbox.js', () => ({
  resolveChatWorkspaceEntry: async () => ({
    absolute: tmpdir(),
    stat: { isDirectory: () => true },
  }),
}))
import {
  closeAllTerminals,
  createTerminal,
  getTerminal,
  resizeTerminal,
  writeTerminal,
  matchesHostKey,
} from '@/service/terminal/manager.js'
import { trustSshHostKey } from '@/utils/sshHostStore.js'
import type { Server } from 'ssh2'
let server: Server
let port = 0
let hostKey = ''
beforeAll(async () => {
  const ssh = createRequire(import.meta.url)('ssh2') as typeof import('ssh2')
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem',
  })
  const parsed = ssh.utils.parseKey(privateKey)
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('test key failure')
  hostKey =
    'SHA256:' +
    createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')
  server = new ssh.Server({ hostKeys: [privateKey] }, (client) => {
    client.on('error', () => undefined)
    client.on('authentication', (context) =>
      context.method === 'password' && context.password === 'test-only'
        ? context.accept()
        : context.reject(),
    )
    client.on('ready', () =>
      client.on('session', (accept) => {
        const session = accept()
        session.on('pty', (accept) => accept?.())
        session.on('window-change', (accept) => accept?.())
        session.on('shell', (accept) => {
          const stream = accept()
          stream.write('ready\r\n')
          stream.on('data', (data: Buffer) => stream.write('echo:' + String(data)))
        })
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as { port: number }).port
})
afterEach(() => {
  closeAllTerminals()
  received.length = 0
})
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})
describe('terminal lifecycle', () => {
  it('runs a local PTY, isolates ownership, supports resize and disconnect cleanup', async () => {
    const session = await createTerminal('owner', 'chat', { kind: 'local' })
    expect(() => getTerminal('another-connection', session.id)).toThrow()
    resizeTerminal('owner', session.id, 90, 26)
    writeTerminal(
      'owner',
      session.id,
      process.platform === 'win32'
        ? "Write-Output ('NYXUS_'+'PTY_EXECUTED')\r"
        : "printf 'NYXUS_%s\\n' PTY_EXECUTED\r",
    )
    await vi.waitFor(
      () =>
        expect(received.map((event) => event.data.data ?? '').join('')).toContain(
          'NYXUS_PTY_EXECUTED',
        ),
      { timeout: 10000 },
    )
    callbacks.onClose('owner')
    expect(() => getTerminal('owner', session.id)).toThrow()
  })
  it('opens an SSH PTY only with a matching fingerprint and forwards input/output', async () => {
    const session = await createTerminal('owner', 'chat', {
      kind: 'ssh',
      host: '127.0.0.1',
      port,
      username: 'test',
      password: 'test-only',
    })
    writeTerminal('owner', session.id, 'hello\r')
    resizeTerminal('owner', session.id, 100, 30)
    await vi.waitFor(() =>
      expect(received.some((event) => event.data.data?.includes('echo:hello'))).toBe(true),
    )
  })
  it('rejects a changed SSH host key after first trust', async () => {
    expect(matchesHostKey(Buffer.from('key'), 'SHA256:wrong')).toBe(false)
    trustSshHostKey('127.0.0.1', port, 'SHA256:wrong')
    await expect(
      createTerminal('owner', 'chat', {
        kind: 'ssh',
        host: '127.0.0.1',
        port,
        username: 'test',
        password: 'test-only',
      }),
    ).rejects.toThrow('指纹不匹配')
    trustSshHostKey('127.0.0.1', port, hostKey)
  })
  it('rejects invalid SSH credentials and removes the failed session', async () => {
    await expect(
      createTerminal('owner', 'chat', {
        kind: 'ssh',
        host: '127.0.0.1',
        port,
        username: 'test',
        password: 'wrong',
      }),
    ).rejects.toThrow('SSH 连接失败')
    const session = await createTerminal('owner', 'chat', {
      kind: 'ssh',
      host: '127.0.0.1',
      port,
      username: 'test',
      password: 'test-only',
    })
    expect(() => writeTerminal('another-connection', session.id, 'unauthorized')).toThrow(
      '不属于当前连接',
    )
    expect(() => resizeTerminal('another-connection', session.id, 80, 24)).toThrow('不属于当前连接')
  })
})
