import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { createRelayService } from '../src/server.js'
import { IdentityStore } from '../src/identityStore.js'
import { RelayBackendClient } from '../src/client.js'

describe('relay backend client', () => {
  it('answers the challenge and writes a private dynamic rathole config', async () => {
    const root = await mkdtemp(join(tmpdir(), 'chery-relay-client-'))
    const service = await createRelayService({
      config: {
        host: '127.0.0.1',
        port: 0,
        publicBasePath: '',
        publicOrigin: 'http://127.0.0.1:4080',
        sessionSecret: 'x'.repeat(32),
        challengeTtlMs: 2_000,
        heartbeatIntervalMs: 50,
        leaseTtlMs: 500,
        sessionTtlSeconds: 300,
        limits: {
          maxOnlineBackends: 10,
          maxControlConnections: 10,
          maxBrowserWebSockets: 10,
          maxWebSocketsPerBackend: 10,
          maxConcurrentHttp: 10,
          maxRequestBytes: 1024,
          requestsPerMinutePerIp: 100,
          upstreamTimeoutMs: 500,
        },
      },
      identityStore: new IdentityStore(),
      logger: () => undefined,
    })
    const address = await service.listen()
    const configPath = join(root, 'rathole-client.toml')
    const statuses: string[] = []
    const client = new RelayBackendClient({
      url: `ws://127.0.0.1:${address.port}/control/backend`,
      backendId: 'client-test',
      displayName: 'Client test',
      configVersion: 1,
      keyFile: join(root, 'identity.json'),
      ratholeServerAddr: 'relay.example:2333',
      ratholeConfigPath: configPath,
      tunnelAddresses: { httpLocalAddr: '127.0.0.1:8183', websocketLocalAddr: '127.0.0.1:8182' },
      tunnelBindAddresses: { httpBindAddr: '127.0.0.1:48081', wsBindAddr: '127.0.0.1:48082' },
      reconnectMinMs: 10,
      ratholeProcessFactory: () => ({
        process: new EventEmitter() as ChildProcess,
        stop: async () => undefined,
      }),
      onStatus: (status) => statuses.push(status),
    })
    await client.start()
    await waitFor(() => client.getStatus() === 'online')
    const config = await readFile(configPath, 'utf8')
    expect(config).toContain('remote_addr = "relay.example:2333"')
    expect(config).toContain('local_addr = "127.0.0.1:8183"')
    expect(config).toContain('local_addr = "127.0.0.1:8182"')
    expect(config).not.toContain('39980')
    expect(statuses).toContain('online')
    await client.stop()
    await service.close()
    await rm(root, { recursive: true, force: true })
  })
})

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(predicate()).toBe(true)
}
