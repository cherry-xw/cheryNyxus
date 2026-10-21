import { readFileSync } from 'node:fs'
import { DeviceAuthorizationStore } from './auth/deviceAuthorizations.js'
import { RelayClientConfigSchema, relayClientRevision } from '../../../relay/src/clientConfig.js'
import { resolve } from 'node:path'
import { RelayBackendClient } from '../../../relay/src/client.js'
import type { ServiceAddresses } from './index.js'

/** The Backend process owns its control client and stops it before listener teardown. */
export async function startBackendRelay(addresses: ServiceAddresses, probeToken: () => string, onAuthorizations: (values: Array<{ id: string; revision: number; subject: string }>) => Promise<void>): Promise<RelayBackendClient | undefined> {
  const file = process.env.CHERY_RELAY_CLIENT_CONFIG_FILE
  if (!file) return undefined
  if (!addresses.remote) throw new Error('Relay requires dedicated remote listeners')
  const raw: unknown = JSON.parse(readFileSync(resolve(file), 'utf8'))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid relay client configuration')
  const cfg = RelayClientConfigSchema.parse(raw)
  const url = new URL(cfg.url as string)
  if (url.protocol !== 'wss:' || url.username || url.password || url.search || url.hash) throw new Error('Relay control requires WSS')
  if (typeof cfg.authorizationFile !== 'string' || typeof cfg.proofIssuer !== 'string') throw new Error('Device authorizationFile and proofIssuer required')
  const authorizations = new DeviceAuthorizationStore(resolve(cfg.authorizationFile), cfg.backendId as string, cfg.proofIssuer)
  await authorizations.load()
  let controlGeneration = 0
  const client = new RelayBackendClient({ url: url.href, backendId: cfg.backendId as string, displayName: cfg.displayName as string, configVersion: 1, desiredRevision: relayClientRevision(cfg), keyFile: resolve(cfg.keyFile as string), ratholeServerAddr: cfg.ratholeServerAddr as string, ratholeConfigPath: resolve(cfg.ratholeConfigPath as string), encryptedTransport: cfg.encryptedTransport as string, ...(typeof cfg.ratholeBinary === 'string' ? { ratholeBinary: cfg.ratholeBinary } : {}), ...(typeof cfg.statusFile === 'string' ? { statusFile: resolve(cfg.statusFile) } : {}), tunnelAddresses: { httpLocalAddr: `127.0.0.1:${addresses.remote.httpPort}`, websocketLocalAddr: `127.0.0.1:${addresses.remote.websocketPort}` }, tunnelBindAddresses: { httpBindAddr: '127.0.0.1:42000', wsBindAddr: '127.0.0.1:43000' }, probeToken, onControlDisconnected: () => { controlGeneration++; void Promise.resolve().then(() => onAuthorizations([])).catch(() => { console.warn('Relay authorization cleanup failed') }) }, onAuthorizations: async (values) => { const generation = controlGeneration; await authorizations.save(values); await onAuthorizations(generation === controlGeneration ? values : []) } })
  await client.start()
  return client
}
