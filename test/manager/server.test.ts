import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createManager,
  isLoopbackAddress,
  isLoopbackHost,
  readBackendNetworkFromConfig,
  readManagerHostFromConfig,
} from '../../manager/src/server.js'

/** 取一个当前空闲的本地端口（避免测试打到真实后端或冲突）。 */
async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const server = createNetServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

describe('local manager', () => {
  it('keeps credential mutation loopback and token protected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-'))
    const configFile = join(root, 'config.yaml')
    const credentialsFile = join(root, 'manager-credentials.json')
    const probePort = await freePort()
    await writeFile(configFile, `server:\n  port: ${probePort}\n  webPort: ${probePort}\n`)
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
      const body = await rotated.json() as {
        credentials: { username: string; consistent: boolean }
        backend: { managed: boolean }
        verification: { status: string }
      }
      expect(body.credentials).toMatchObject({ username: 'admin', consistent: true })
      // 后端不是管理器子进程：不拉起副本，如实上报 managed=false。
      expect(body.backend.managed).toBe(false)
      // 自检端口无监听 → unreachable（确定性，不依赖外部环境）。
      expect(body.verification.status).toBe('unreachable')
      expect(JSON.parse(await readFile(credentialsFile, 'utf8'))).toMatchObject({
        username: 'admin',
        password: 'test-password',
      })
      expect((await readFile(configFile, 'utf8'))).toContain('username: admin')
    } finally {
      await manager.close()
    }
  })

  it('accepts the manager token from the URL query parameter', async () => {
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
      const noToken = await fetch(`${base}/api/credentials`)
      expect(noToken.status).toBe(401)

      const queryToken = await fetch(`${base}/api/credentials?token=test-token`)
      expect(queryToken.status).toBe(200)

      const wrongToken = await fetch(`${base}/api/credentials?token=wrong`)
      expect(wrongToken.status).toBe(401)

      const page = await fetch(`${base}/`)
      expect(page.status).toBe(200)
    } finally {
      await manager.close()
    }
  })

  it('serves the manager page with the token carried on every internal API call', async () => {
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
      const page = await fetch(`${base}/`)
      expect(page.status).toBe(200)
      const html = await page.text()
      // 内网门禁要求全部 /api/* 带密钥：页面内部 status/credentials/rotate 三个请求 + 续期读取共 4 处。
      expect(html.split('X-Chery-Manager-Token').length - 1).toBe(4)
      // 状态请求不能退回无 token 的裸请求（内网访问会 401）。
      expect(html).not.toContain("fetch('/api/status');")
      // 页面不再整段打印状态 JSON，改为逐项状态行。
      expect(html).not.toContain("show('status',JSON.stringify")
      expect(html).toContain('id="processes"')
      // 管理密钥不再显示为输入框，只存 localStorage / Cookie。
      expect(html).not.toContain('id="manager-token"')
      expect(html).toContain("const TOKEN_KEY='chery-manager-token';")
      // 凭据表单：必填用户名 / 新密码 + 随机生成 + 显示/隐藏 + 可见标签。
      expect(html).toContain('id="random-password"')
      expect(html).toContain('id="toggle-password"')
      expect(html).toContain('<label for="username">')
      expect(html).toContain('<label for="password">')
      // 轮换后如实上报：成功自检 / 后端不可达 / 未生效三种文案 + 引导重新登录。
      expect(html).toContain('保存凭据并生效')
      expect(html).toContain('新密码已确认生效')
      expect(html).toContain('请确认后端已启动')
      // 仅本机监听时页面不应出现局域网安全警告。
      expect(html).not.toContain('局域网访问已开启')
    } finally {
      await manager.close()
    }
  })
})

describe('readBackendNetworkFromConfig', () => {
  it('reads server.port / server.webPort / server.host from config.yaml', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-'))
    const configFile = join(root, 'config.yaml')
    await writeFile(configFile, 'server:\n  port: 9991\n  webPort: 9992\n  host: 0.0.0.0\n')
    await expect(readBackendNetworkFromConfig(configFile)).resolves.toEqual({
      host: '0.0.0.0',
      wsPort: 9991,
      webPort: 9992,
    })
  })

  it('falls back to defaults for missing or broken config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-'))
    const noServer = join(root, 'no-server.yaml')
    await writeFile(noServer, 'global:\n  supervision: smart\n')
    await expect(readBackendNetworkFromConfig(noServer)).resolves.toEqual({
      host: '127.0.0.1',
      wsPort: 8182,
      webPort: 8183,
    })
    await expect(readBackendNetworkFromConfig(join(root, 'missing.yaml'))).resolves.toEqual({
      host: '127.0.0.1',
      wsPort: 8182,
      webPort: 8183,
    })
    await expect(readBackendNetworkFromConfig(undefined)).resolves.toEqual({
      host: '127.0.0.1',
      wsPort: 8182,
      webPort: 8183,
    })
  })
})

describe('isLoopbackAddress', () => {
  it('recognises loopback forms and rejects intranet addresses', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.5')).toBe(false)
    expect(isLoopbackAddress('10.0.0.2')).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

describe('readManagerHostFromConfig', () => {
  it('reads manager.host from config.yaml', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-config-'))
    const configFile = join(root, 'config.yaml')
    await writeFile(configFile, 'server:\n  port: 8182\nmanager:\n  host: 0.0.0.0\n')
    await expect(readManagerHostFromConfig(configFile)).resolves.toBe('0.0.0.0')
  })

  it('returns undefined when manager section or host is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-config-'))
    const configFile = join(root, 'config.yaml')
    await writeFile(configFile, 'server:\n  port: 8182\n')
    await expect(readManagerHostFromConfig(configFile)).resolves.toBeUndefined()
  })

  it('returns undefined for missing file and invalid shapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-config-'))
    const missing = join(root, 'nope.yaml')
    await expect(readManagerHostFromConfig(missing)).resolves.toBeUndefined()
    const badHost = join(root, 'bad-host.yaml')
    await writeFile(badHost, 'manager:\n  host: 123\n')
    await expect(readManagerHostFromConfig(badHost)).resolves.toBeUndefined()
    const badManager = join(root, 'bad-manager.yaml')
    await writeFile(badManager, 'manager: nope\n')
    await expect(readManagerHostFromConfig(badManager)).resolves.toBeUndefined()
  })
})

describe('backend status detection', () => {
  async function listenOnRandomPort(): Promise<{ port: number; close: () => Promise<void> }> {
    const server = createNetServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    return {
      port,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    }
  }

  async function newManager(root: string, configFile: string): Promise<{
    base: string
    close: () => Promise<void>
  }> {
    const credentialsFile = join(root, 'manager-credentials.json')
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
    return { base: `http://127.0.0.1:${manager.address()!.port}`, close: () => manager.close() }
  }

  it('reports the backend running when its WS port is reachable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-'))
    const backend = await listenOnRandomPort()
    const configFile = join(root, 'config.yaml')
    await writeFile(configFile, `server:\n  port: ${backend.port}\n  webPort: 8183\n`)
    const manager = await newManager(root, configFile)
    try {
      const response = await fetch(`${manager.base}/api/status`)
      const status = await response.json() as { backend: { status: string; addresses: { local: { httpPort: number } } } }
      expect(status.backend.status).toBe('running')
      expect(status.backend.addresses.local.httpPort).toBe(8183)
    } finally {
      await manager.close()
      await backend.close()
    }
  })

  it('reports the backend stopped when its WS port is not reachable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-'))
    const freed = await listenOnRandomPort()
    const closedPort = freed.port
    await freed.close()
    const configFile = join(root, 'config.yaml')
    await writeFile(configFile, `server:\n  port: ${closedPort}\n  webPort: 8183\n`)
    const manager = await newManager(root, configFile)
    try {
      const response = await fetch(`${manager.base}/api/status`)
      const status = await response.json() as { backend: { status: string } }
      expect(status.backend.status).toBe('stopped')
    } finally {
      await manager.close()
    }
  })
})

describe('isLoopbackHost', () => {
  it('treats defaults and loopback hosts as loopback, others as LAN', () => {
    expect(isLoopbackHost(undefined)).toBe(true)
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.5')).toBe(false)
  })
})

describe('manager token lifecycle', () => {
  function baseOptions(root: string) {
    return {
      host: '127.0.0.1' as const,
      port: 0,
      configFile: join(root, 'config.yaml'),
      credentialsFile: join(root, 'manager-credentials.json'),
      backendCommand: process.execPath,
      backendArgs: ['-e', 'setTimeout(() => {}, 10000)'],
    }
  }

  it('persists the generated token across restarts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-'))
    const tokenFile = join(root, 'manager-token.json')
    const first = createManager({ ...baseOptions(root), tokenFile })
    const second = createManager({ ...baseOptions(root), tokenFile })
    // 不监听也无需文件 IO 之外的启动流程：token 在 createManager 阶段已从同一文件解析。
    expect(second.token).toBe(first.token)
  })

  it('emits the renewal header and cookie on an authenticated response and never without a token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-'))
    await writeFile(join(root, 'config.yaml'), 'server:\n  port: 8182\n  webPort: 8183\n')
    const manager = createManager({ ...baseOptions(root), controlToken: 'test-token' })
    await manager.listen()
    const base = `http://127.0.0.1:${manager.address()!.port}`
    try {
      const withToken = await fetch(`${base}/api/status`, {
        headers: { 'X-Chery-Manager-Token': 'test-token' },
      })
      expect(withToken.status).toBe(200)
      expect(withToken.headers.get('x-chery-manager-token')).toBe('test-token')
      expect(withToken.headers.get('set-cookie')).toContain('chery-manager-token=test-token')

      const withoutToken = await fetch(`${base}/api/status`)
      expect(withoutToken.status).toBe(200) // 回环只读免密钥
      expect(withoutToken.headers.get('x-chery-manager-token')).toBeNull()
      expect(withoutToken.headers.get('set-cookie')).toBeNull()
    } finally {
      await manager.close()
    }
  })

  it('shows the LAN danger warning only when listening beyond loopback', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-'))
    await writeFile(join(root, 'config.yaml'), 'server:\n  port: 8182\n  webPort: 8183\n')
    const lan = createManager({ ...baseOptions(root), host: '0.0.0.0', controlToken: 't' })
    await lan.listen()
    const lanBase = `http://127.0.0.1:${lan.address()!.port}`
    try {
      const page = await fetch(`${lanBase}/`)
      expect(await page.text()).toContain('局域网访问已开启')
    } finally {
      await lan.close()
    }
  })

  it('restarts a manager-owned backend and confirms the new credentials via login self-test', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-manager-'))
    const port = await freePort()
    const configFile = join(root, 'config.yaml')
    const credentialsFile = join(root, 'manager-credentials.json')
    await writeFile(configFile, `server:\n  port: ${port}\n  webPort: ${port}\n`)
    // 假后端：对 challenge/login 固定返回 200，监听 CHERY_TEST_PORT。
    const fakeBackend = `
      const http = require('node:http');
      const port = Number(process.env.CHERY_TEST_PORT);
      const server = http.createServer((req, res) => {
        if (req.url === '/api/auth/challenge' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ challengeId: 'c1', nonce: '0'.repeat(48) }));
          return;
        }
        if (req.url === '/api/auth/login' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ accessToken: 'at', refreshToken: 'rt', username: 'alice' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
      server.listen(port, '127.0.0.1');
    `
    process.env.CHERY_TEST_PORT = String(port)
    const manager = createManager({
      host: '127.0.0.1',
      port: 0,
      controlToken: 'test-token',
      configFile,
      credentialsFile,
      backendCommand: process.execPath,
      backendArgs: ['-e', fakeBackend],
    })
    await manager.listen()
    const base = `http://127.0.0.1:${manager.address()!.port}`
    try {
      const start = await fetch(`${base}/api/backend/start`, {
        method: 'POST',
        headers: { 'X-Chery-Manager-Token': 'test-token' },
      })
      expect(start.status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const rotated = await fetch(`${base}/api/credentials/rotate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Chery-Manager-Token': 'test-token' },
        body: JSON.stringify({ username: 'alice', password: 'new-password' }),
      })
      expect(rotated.status).toBe(200)
      const data = await rotated.json() as {
        backend: { managed: boolean }
        verification: { status: string }
      }
      // 托管后端：管理器执行真正重启，且自检确认新凭据已生效。
      expect(data.backend.managed).toBe(true)
      expect(data.verification.status).toBe('verified')
    } finally {
      delete process.env.CHERY_TEST_PORT
      await manager.close()
    }
  })
})
