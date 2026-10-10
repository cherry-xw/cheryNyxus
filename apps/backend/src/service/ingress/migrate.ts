import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { dump } from 'js-yaml'
import { IngressStore, ingressError, packageDigest, readManifest } from './store.js'
import type { IngressRegistration } from './api.js'

/** Explicit offline conversion; no package execution and no implicit grants. */
export function migrateIngressV1(store: IngressStore): void {
  store.withMaintenanceLock(() => migrateLocked(store))
}
function migrateLocked(store: IngressStore): void {
  store.initialize()
  const marker = 'migration-api2.json'
  if (fs.existsSync(store.safe(marker))) {
    store.readRegistry()
    return
  }
  const registry = store.readJson('registry.json') as {
    schemaVersion?: number
    revision?: number
    plugins?: unknown[]
  }
  if (
    registry.schemaVersion !== 1 ||
    !Number.isSafeInteger(registry.revision) ||
    registry.revision! < 0 ||
    !Array.isArray(registry.plugins)
  )
    throw ingressError('INVALID_PARAMS')
  const backup = `backups/api1-${randomUUID()}`
  store.directory(backup)
  fs.copyFileSync(store.safe('registry.json'), store.safe(`${backup}/registry.json`))
  fs.chmodSync(store.safe(`${backup}/registry.json`), 0o600)
  const plugins: IngressRegistration[] = []
  const created: string[] = []
  try {
    for (const raw of registry.plugins) {
      const entry = raw as {
        id: string
        version: string
        enabled: boolean
        apiVersion: number
        packageDigest: string
      }
      if (entry.apiVersion !== 1 || typeof entry.enabled !== 'boolean')
        throw ingressError('INVALID_PARAMS')
      const directory = store.packageDirectory(entry)
      const legacyPath = path.relative(store.root, path.join(directory, 'ingress-plugin.json'))
      const legacy = store.readJson(legacyPath) as Record<string, unknown>
      if (
        legacy.id !== entry.id ||
        legacy.version !== entry.version ||
        legacy.apiVersion !== 1 ||
        packageDigest(directory) !== entry.packageDigest
      )
        throw ingressError('INVALID_PARAMS')
      if (fs.existsSync(path.join(directory, 'config.yaml')))
        throw ingressError('REGISTRATION_CONFLICT')
      store.directory(`${backup}/${entry.id}`)
      fs.copyFileSync(
        store.safe(legacyPath),
        store.safe(`${backup}/${entry.id}/ingress-plugin.json`),
      )
      const config = {
        id: entry.id,
        version: entry.version,
        apiVersion: 2,
        entry: legacy.entry,
        dependencies: [],
        capabilities: ['rpc.business', 'rpc.management', 'ingress'],
        ...(legacy.rpcNamespace === undefined ? {} : { rpcNamespace: legacy.rpcNamespace }),
      }
      const target = path.join(directory, 'config.yaml')
      fs.writeFileSync(target, dump(config), { mode: 0o600, flag: 'wx' })
      created.push(target)
      try {
        const manifest = readManifest(directory)
        plugins.push({
          ...manifest,
          enabled: false,
          packageDigest: packageDigest(directory),
          grantedCapabilities: [],
          channelGrants: [],
        })
      } catch (error) {
        throw error
      }
    }
    if (new Set(plugins.map((item) => item.id)).size !== plugins.length)
      throw ingressError('REGISTRATION_CONFLICT')
    store.atomicJson('registry.json', {
      schemaVersion: 2,
      revision: registry.revision! + 1,
      plugins,
    })
    store.atomicJson(marker, {
      schemaVersion: 1,
      backup,
      disabledForReview: plugins.map((item) => item.id),
    })
  } catch (error) {
    fs.copyFileSync(store.safe(`${backup}/registry.json`), store.safe('registry.json'))
    for (const target of created) if (fs.existsSync(target)) fs.unlinkSync(target)
    throw error
  }
}
