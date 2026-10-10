import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { z } from 'zod'
import { load as loadYaml } from 'js-yaml'
import {
  IngressCapabilitySchema,
  IngressChannelGrantSchema,
  IngressUiDescriptorSchema,
} from '@chery/protocol'
import type { IngressCapability } from '@chery/protocol'
import type {
  IngressConfigSnapshot,
  IngressManifest,
  IngressRegistry,
  IngressRegistration,
} from './api.js'

const idSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)
const versionSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/)
const manifestSchema = z
  .object({
    id: idSchema,
    version: versionSchema,
    apiVersion: z.literal(2),
    entry: z.string().min(1),
    dependencies: z.array(z.object({ id: idSchema, version: versionSchema }).strict()),
    capabilities: z.array(IngressCapabilitySchema),
    ui: z.array(IngressUiDescriptorSchema).optional(),
    rpcNamespace: idSchema.optional(),
    resources: z.array(z.object({
      id: idSchema,
      kind: z.enum(['skill', 'script']),
      path: z.string().min(1),
      channel: idSchema.optional(),
    }).strict()).optional(),
  })
  .strict()
const registrationSchema = manifestSchema.extend({
  enabled: z.boolean(),
  packageDigest: z.string().regex(/^[a-f0-9]{64}$/),
  grantedCapabilities: z.array(IngressCapabilitySchema),
  channelGrants: z.array(IngressChannelGrantSchema),
})
const registrySchema = z
  .object({
    schemaVersion: z.literal(2),
    revision: z.number().int().nonnegative(),
    plugins: z.array(registrationSchema),
  })
  .strict()
const configSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: z.number().int().nonnegative(),
    config: z.unknown(),
  })
  .strict()

export class IngressStore {
  readonly root: string
  constructor(cheryDir = process.env.CHERY_DIR || process.cwd()) {
    this.root = path.resolve(cheryDir, '.chery', 'ingress')
  }
  /** No symlinks at any ancestor, not merely the leaf being opened. */
  safe(relative = ''): string {
    if (path.isAbsolute(relative) || relative.includes('\\'))
      throw new Error('Invalid ingress path')
    const target = path.resolve(this.root, relative)
    if (target !== this.root && !target.startsWith(`${this.root}${path.sep}`))
      throw new Error('Ingress path escape')
    let cursor = path.parse(target).root
    for (const part of target.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part)
      if (
        fs.existsSync(cursor) ||
        (() => {
          try {
            fs.lstatSync(cursor)
            return true
          } catch {
            return false
          }
        })()
      ) {
        if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Ingress symlink rejected')
      }
    }
    return target
  }
  directory(relative: string): string {
    const target = this.safe(relative)
    fs.mkdirSync(target, { recursive: true, mode: 0o700 })
    fs.chmodSync(target, 0o700)
    return target
  }
  initialize(): void {
    for (const folder of ['', 'packages', 'config', 'data', 'backups']) this.directory(folder)
  }
  readRegistry(): IngressRegistry {
    const file = this.safe('registry.json')
    if (!fs.existsSync(file)) return { schemaVersion: 2, revision: 0, plugins: [] }
    const result = registrySchema.parse(this.readJson('registry.json'))
    const ids = result.plugins.map((entry) => entry.id)
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate ingress ID')
    for (const entry of result.plugins) {
      validateManifest(entry)
      validateGrants(entry, entry.grantedCapabilities, entry.channelGrants)
    }
    return result
  }
  packageDirectory(entry: Pick<IngressRegistration, 'id' | 'version'>): string {
    idSchema.parse(entry.id)
    versionSchema.parse(entry.version)
    return this.safe(`packages/${entry.id}/${entry.version}`)
  }
  readConfig(id: string): IngressConfigSnapshot | undefined {
    idSchema.parse(id)
    const name = `config/${id}.json`
    if (!fs.existsSync(this.safe(name))) return undefined
    return configSchema.parse(this.readJson(name))
  }
  saveConfig(id: string, config: unknown, expectedBaseRevision: number): IngressConfigSnapshot {
    idSchema.parse(id)
    return this.lock(() => {
      const current = this.readConfig(id)
      if ((current?.revision ?? 0) !== expectedBaseRevision)
        throw Object.assign(new Error('Ingress configuration revision conflict'), {
          code: 'REVISION_CONFLICT',
        })
      const next: IngressConfigSnapshot = {
        schemaVersion: 1,
        revision: expectedBaseRevision + 1,
        config,
      }
      if (current) this.backup(`config/${id}.json`)
      this.atomicJson(`config/${id}.json`, next)
      return next
    })
  }
  install(
    source: string,
    upgrade = false,
    expectedDigest?: string,
    grants: {
      grantedCapabilities: IngressCapability[]
      channelGrants: Array<{ channel: string; credentialKind: string }>
    } = { grantedCapabilities: [], channelGrants: [] },
    expectedRevision?: number,
  ): IngressRegistration {
    return this.lock(() => {
      const sourceRoot = path.resolve(source)
      if (sourceRoot === this.root || sourceRoot.startsWith(`${this.root}${path.sep}`))
        throw new Error('Install source must be outside managed ingress')
      const manifest = readManifest(sourceRoot)
      const files = packageFiles(sourceRoot)
      const registry = this.readRegistry()
      if (expectedRevision !== undefined && registry.revision !== expectedRevision)
        throw ingressError('REVISION_CONFLICT')
      validateGrants(manifest, grants.grantedCapabilities, grants.channelGrants)
      const previous = registry.plugins.find((item) => item.id === manifest.id)
      if (upgrade ? !previous : !!previous)
        throw new Error(upgrade ? 'Plugin is not installed' : 'Duplicate ingress ID; use upgrade')
      if (previous?.version === manifest.version) throw new Error('Version is already installed')
      const destination = this.packageDirectory(manifest)
      if (fs.existsSync(destination)) throw new Error('Installed version cannot be overwritten')
      this.directory(`packages/${manifest.id}`)
      const stageRelative = `packages/${manifest.id}/.stage-${randomUUID()}`
      const stage = this.directory(stageRelative)
      let published = false
      try {
        for (const relative of files) {
          const sourceFile = path.join(sourceRoot, relative)
          const stat = fs.lstatSync(sourceFile)
          if (!stat.isFile() || stat.isSymbolicLink())
            throw new Error('Package changed during install')
          const target = path.join(stage, relative)
          fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
          fs.copyFileSync(sourceFile, target, fs.constants.COPYFILE_EXCL)
          fs.chmodSync(target, 0o600)
        }
        const copiedManifest = readManifest(stage)
        if (JSON.stringify(copiedManifest) !== JSON.stringify(manifest))
          throw new Error('Manifest changed during install')
        const digest = packageDigest(stage)
        if (
          digest !== packageDigest(sourceRoot) ||
          (expectedDigest !== undefined && digest !== expectedDigest)
        )
          throw new Error('Package digest mismatch')
        // Syntax-only check never executes package code or resolves its imports.
        execFileSync(process.execPath, ['--check', path.join(stage, manifest.entry)], {
          stdio: 'pipe',
          timeout: 10_000,
        })
        const next: IngressRegistration = {
          ...manifest,
          enabled: previous?.enabled ?? false,
          packageDigest: digest,
          grantedCapabilities: structuredClone(grants.grantedCapabilities),
          channelGrants: structuredClone(grants.channelGrants),
        }
        if (fs.existsSync(this.safe('registry.json'))) this.backup('registry.json')
        fs.renameSync(stage, destination)
        published = true
        this.atomicJson('registry.json', {
          schemaVersion: 2,
          revision: registry.revision + 1,
          plugins: [...registry.plugins.filter((item) => item.id !== manifest.id), next],
        })
        return next
      } catch (error) {
        fs.rmSync(published ? destination : stage, { recursive: true, force: true })
        throw error
      }
    })
  }
  setEnabled(id: string, enabled: boolean, expectedRevision?: number): void {
    idSchema.parse(id)
    this.lock(() => {
      const registry = this.readRegistry()
      const entry = registry.plugins.find((item) => item.id === id)
      if (expectedRevision !== undefined && registry.revision !== expectedRevision)
        throw ingressError('REVISION_CONFLICT')
      if (!entry) throw new Error('Plugin is not installed')
      if (entry.enabled === enabled) return
      this.backup('registry.json')
      this.atomicJson('registry.json', {
        ...registry,
        revision: registry.revision + 1,
        plugins: registry.plugins.map((item) => (item.id === id ? { ...item, enabled } : item)),
      })
    })
  }
  uninstall(id: string, expectedRevision?: number): void {
    idSchema.parse(id)
    this.lock(() => {
      const registry = this.readRegistry()
      if (!registry.plugins.some((item) => item.id === id))
        throw new Error('Plugin is not installed')
      if (expectedRevision !== undefined && registry.revision !== expectedRevision)
        throw ingressError('REVISION_CONFLICT')
      this.backup('registry.json')
      this.atomicJson('registry.json', {
        ...registry,
        revision: registry.revision + 1,
        plugins: registry.plugins.filter((item) => item.id !== id),
      })
    })
  }
  verify(entry: IngressRegistration): string {
    const directory = this.packageDirectory(entry)
    const manifest = readManifest(directory)
    const {
      enabled: _enabled,
      packageDigest: _digest,
      grantedCapabilities: _grants,
      channelGrants: _channels,
      ...registeredManifest
    } = entry
    if (JSON.stringify(manifest) !== JSON.stringify(manifestSchema.parse(registeredManifest)))
      throw new Error('Installed manifest mismatch')
    if (packageDigest(directory) !== entry.packageDigest)
      throw new Error('Installed package digest mismatch')
    return path.join(directory, entry.entry)
  }
  readJson(relative: string): unknown {
    const target = this.safe(relative)
    const stat = fs.statSync(target)
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid ingress JSON file')
    return JSON.parse(fs.readFileSync(target, 'utf8'))
  }
  atomicJson(relative: string, value: unknown): void {
    const target = this.safe(relative)
    const temporary = this.safe(`${relative}.${randomUUID()}.tmp`)
    const text = `${JSON.stringify(value)}\n`
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error('Ingress JSON exceeds limit')
    const fd = fs.openSync(temporary, 'wx', 0o600)
    try {
      fs.writeFileSync(fd, text)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    try {
      fs.renameSync(temporary, target)
    } finally {
      fs.rmSync(temporary, { force: true })
    }
  }
  private backup(relative: string): void {
    const destination = this.safe(`backups/${path.basename(relative)}-${randomUUID()}`)
    fs.copyFileSync(this.safe(relative), destination, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(destination, 0o600)
  }
  private lock<T>(action: () => T): T {
    this.initialize()
    const target = this.safe('.maintenance-lock')
    const fd = fs.openSync(target, 'wx', 0o600)
    try {
      return action()
    } finally {
      fs.closeSync(fd)
      fs.unlinkSync(target)
    }
  }
  /** Offline migration shares the registry mutation lock. */
  withMaintenanceLock<T>(action: () => T): T {
    return this.lock(action)
  }
}
export function ingressError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code })
}
export function validateResourcePath(value: string): void {
  if (
    !value ||
    path.isAbsolute(value) ||
    /[\\?#:]/.test(value) ||
    value.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw ingressError('INVALID_PARAMS')
}
function validateManifest(manifest: IngressManifest): void {
  validateEntry(manifest.entry)
  validateResourcePath(manifest.entry)
  const resources = manifest.resources ?? []
  if (new Set(resources.map(resource => resource.id)).size !== resources.length)
    throw ingressError('INVALID_PARAMS')
  for (const resource of resources) {
    validateResourcePath(resource.path)
    if (resource.kind === 'skill' && path.basename(resource.path) !== 'SKILL.md')
      throw ingressError('INVALID_PARAMS')
  }
  if (
    new Set(manifest.capabilities).size !== manifest.capabilities.length ||
    new Set(manifest.dependencies.map((dep) => dep.id)).size !== manifest.dependencies.length ||
    manifest.dependencies.some((dep) => dep.id === manifest.id)
  )
    throw ingressError('INVALID_PARAMS')
  const modules = new Set<string>()
  for (const ui of manifest.ui ?? []) {
    validateResourcePath(ui.entry)
    if (
      !ui.entry.endsWith('.html') ||
      ui.apiPrefix !== `/api/modules/${ui.id}/` ||
      modules.has(ui.id)
    )
      throw ingressError('INVALID_PARAMS')
    modules.add(ui.id)
  }
}
function validateGrants(
  manifest: IngressManifest,
  granted: IngressCapability[],
  channels: Array<{ channel: string; credentialKind: string }>,
): void {
  z.array(IngressCapabilitySchema).parse(granted)
  z.array(IngressChannelGrantSchema).parse(channels)
  if (
    new Set(granted).size !== granted.length ||
    granted.some((cap) => !manifest.capabilities.includes(cap)) ||
    (channels.length && !granted.includes('channel.identity')) ||
    new Set(channels.map((grant) => grant.channel)).size !== channels.length
    || (manifest.resources ?? []).some(resource => resource.channel &&
      !channels.some(grant => grant.channel === resource.channel))
  )
    throw ingressError('CAPABILITY_DENIED')
}
function validateEntry(entry: string): void {
  if (
    path.isAbsolute(entry) ||
    entry.includes('\\') ||
    entry.split('/').some((part) => !part || part === '.' || part === '..') ||
    !/\.(mjs|js)$/.test(entry)
  )
    throw new Error('Invalid ESM entry path')
}
export function readManifest(root: string): IngressManifest {
  // Walk the whole tree first, including ancestors; no source symlinks are admitted.
  packageFiles(root)
  const manifest = manifestSchema.parse(
    loadYaml(fs.readFileSync(path.join(root, 'config.yaml'), 'utf8'), { json: false }),
  )
  validateManifest(manifest)
  for (const resource of manifest.resources ?? [])
    if (!fs.statSync(path.join(root, resource.path)).isFile()) throw ingressError('INVALID_PARAMS')
  for (const ui of manifest.ui ?? [])
    if (!fs.statSync(path.join(root, ui.entry)).isFile()) throw ingressError('INVALID_PARAMS')
  if (!fs.statSync(path.join(root, manifest.entry)).isFile())
    throw new Error('Missing package entry')
  if (manifest.entry.endsWith('.js')) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      type?: string
    }
    if (packageJson.type !== 'module') throw new Error('JS entry requires ESM package type')
  }
  return manifest
}
function packageFiles(root: string): string[] {
  let ancestor = path.resolve(root)
  while (true) {
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Package symlink rejected')
    const parent = path.dirname(ancestor)
    if (parent === ancestor) break
    ancestor = parent
  }
  const files: string[] = []
  let total = 0
  function walk(relative: string, depth: number): void {
    if (depth > 32) throw new Error('Package nesting limit exceeded')
    for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
      if (name.includes('\\')) throw new Error('Invalid package filename')
      const child = path.join(relative, name)
      const stat = fs.lstatSync(path.join(root, child))
      if (stat.isSymbolicLink()) throw new Error('Package symlink rejected')
      if (stat.isDirectory()) walk(child, depth + 1)
      else if (stat.isFile()) {
        total += stat.size
        files.push(child)
        if (total > 64 * 1024 * 1024 || files.length > 4096)
          throw new Error('Package size limit exceeded')
      } else throw new Error('Package special file rejected')
    }
  }
  if (!fs.statSync(root).isDirectory()) throw new Error('Package source must be directory')
  walk('', 0)
  return files.sort()
}
export function packageDigest(root: string): string {
  const hash = createHash('sha256')
  for (const file of packageFiles(root)) {
    const bytes = fs.readFileSync(path.join(root, file))
    hash.update(JSON.stringify([file.split(path.sep).join('/'), bytes.length]))
    hash.update('\0')
    hash.update(bytes)
    hash.update('\0')
  }
  return hash.digest('hex')
}
