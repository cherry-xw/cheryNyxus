import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, relative, resolve, sep } from 'node:path'
import yaml from 'js-yaml'

const MANIFEST_NAME = '.template-manifest.json'
const MANIFEST_VERSION = 1
const CONFIG_MIGRATION = 'role-design-acceptance-v1'
const UNMANAGED_TEMPLATE_FILES = new Set(['config.yaml', MANIFEST_NAME])

// First adoption predates the per-workspace manifest. These hashes are official
// Cherry Nexus prompts shipped by earlier releases, so replacing them is safe.
// Any other existing content is treated as user-modified and preserved.
const LEGACY_MANAGED_HASHES = {
  // Early model-catalog adoption created this empty official seed before its
  // template hash was tracked consistently. It is safe to upgrade; any file
  // containing user rules has a different hash and remains preserved.
  'model-catalog.yaml': new Set([
    'd80f28437c18fae404a3d5ecd2d883dd4b2deec125174b32e6347c47bfb23b31',
  ]),
  'prompt/cheryNyxus/cheryNyxus.md': new Set([
    '34e035f44692fbd6ad8d3af100e6cb8700b8fc4f2d3bc85f0e2923d8dc96345a',
    'faa58ce638570401d2c3e37799be6cae56e4400d8d1bce653357a55ecdc55eca',
    '060a6fda49e54a578619eaf9f697179b8b623c1e75fbb30ad71b0ba0859351dd',
  ]),
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedRelative(root, absolute) {
  const value = relative(root, absolute).replaceAll('\\', '/')
  if (!value || value === '..' || value.startsWith('../') || value.includes('/../')) {
    throw new Error(`模板文件路径越界：${absolute}`)
  }
  return value
}

function walkFiles(root) {
  const result = []
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile()) result.push(absolute)
    }
  }
  visit(root)
  return result.sort((a, b) => a.localeCompare(b))
}

function hasSymlinkSegment(root, target) {
  const rel = relative(root, target)
  if (!rel || rel === '.') return false
  let current = root
  for (const part of rel.split(sep)) {
    current = join(current, part)
    if (!existsSync(current)) continue
    if (lstatSync(current).isSymbolicLink()) return true
  }
  return false
}

function readManifest(path) {
  if (!existsSync(path)) return { version: MANIFEST_VERSION, files: {}, migrations: {} }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value?.version !== MANIFEST_VERSION || typeof value.files !== 'object') {
      return { version: MANIFEST_VERSION, files: {}, migrations: {} }
    }
    return {
      version: MANIFEST_VERSION,
      files: value.files ?? {},
      migrations: value.migrations ?? {},
    }
  } catch {
    return { version: MANIFEST_VERSION, files: {}, migrations: {} }
  }
}

function replaceFile(target, content, backup) {
  mkdirSync(dirname(target), { recursive: true })
  const candidate = `${target}.candidate-${process.pid}-${randomUUID()}`
  writeFileSync(candidate, content)
  let moved = false
  try {
    if (existsSync(target)) {
      mkdirSync(dirname(backup), { recursive: true })
      renameSync(target, backup)
      moved = true
    }
    renameSync(candidate, target)
  } catch (error) {
    rmSync(candidate, { force: true })
    if (moved && !existsSync(target) && existsSync(backup)) renameSync(backup, target)
    throw error
  }
}

function writeManifest(path, manifest) {
  mkdirSync(dirname(path), { recursive: true })
  const candidate = `${path}.candidate-${process.pid}-${randomUUID()}`
  writeFileSync(candidate, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  const previous = `${path}.previous-${process.pid}`
  let moved = false
  try {
    if (existsSync(path)) {
      rmSync(previous, { force: true })
      renameSync(path, previous)
      moved = true
    }
    renameSync(candidate, path)
    if (moved) rmSync(previous, { force: true })
  } catch (error) {
    rmSync(candidate, { force: true })
    if (moved && !existsSync(path) && existsSync(previous)) renameSync(previous, path)
    throw error
  }
}

function stableRoleId() {
  return `role-${randomUUID().replaceAll('-', '').slice(0, 16)}`
}

function hasSense(group, senseName) {
  return group.some(
    (entry) => typeof entry === 'string' && entry.split(':', 1)[0]?.trim() === senseName,
  )
}

function migrateBuiltInConfig(templatePath, targetPath, backupRoot, previousMigrations) {
  if (previousMigrations[CONFIG_MIGRATION]) return { changed: false, applied: true }
  if (!existsSync(templatePath) || !existsSync(targetPath))
    return { changed: false, applied: false }

  let source
  let target
  try {
    source = yaml.load(readFileSync(templatePath, 'utf8'))
    target = yaml.load(readFileSync(targetPath, 'utf8'))
  } catch (error) {
    return { changed: false, applied: false, warning: `配置迁移跳过：${error.message}` }
  }
  if (!source || !target || typeof source !== 'object' || typeof target !== 'object') {
    return { changed: false, applied: false, warning: '配置迁移跳过：config.yaml 不是对象' }
  }

  const templateGroups = source.sense_groups ?? {}
  const templateRoles = source.roles ?? {}
  const targetRoles = (target.roles ??= {})
  const targetGroups = (target.sense_groups ??= {})
  const targetPresets = (target.presets ??= {})
  const nexusRole = targetRoles.cheryNyxus
  const nexusPreset = targetPresets.cheryNyxus
  if (!nexusRole?.brain || !nexusPreset || !Array.isArray(nexusPreset.roles)) {
    return {
      changed: false,
      applied: false,
      warning: '配置迁移跳过：缺少 roles.cheryNyxus 或 presets.cheryNyxus 固定资源',
    }
  }

  let changed = false
  for (const groupName of ['role_architect', 'role_acceptance']) {
    if (targetGroups[groupName] === undefined && Array.isArray(templateGroups[groupName])) {
      targetGroups[groupName] = structuredClone(templateGroups[groupName])
      changed = true
    }
  }
  if (Array.isArray(targetGroups.chery_nexus)) {
    for (const sense of ['config_manage', 'role_acceptance']) {
      if (!hasSense(targetGroups.chery_nexus, sense)) {
        targetGroups.chery_nexus.push(sense)
        changed = true
      }
    }
  }

  for (const roleName of ['roleArchitect', 'roleAcceptance']) {
    if (targetRoles[roleName] !== undefined || templateRoles[roleName] === undefined) continue
    targetRoles[roleName] = {
      ...structuredClone(templateRoles[roleName]),
      id: stableRoleId(),
      brain: nexusRole.brain,
    }
    changed = true
  }
  for (const roleName of ['roleArchitect', 'roleAcceptance']) {
    if (targetRoles[roleName] && !nexusPreset.roles.includes(roleName)) {
      nexusPreset.roles.push(roleName)
      changed = true
    }
  }

  if (!changed) return { changed: false, applied: true }
  const rendered = yaml.dump(target, { lineWidth: -1 })
  const backup = join(backupRoot, 'config.yaml')
  replaceFile(targetPath, rendered, backup)
  return { changed: true, applied: true, backup }
}

export function ensureEnvSeed({ envExamplePath, runtimeRoot }) {
  const target = resolve(runtimeRoot, '.env')
  if (existsSync(target)) return { created: false, target }
  if (!existsSync(envExamplePath)) return { created: false, target, warning: '缺少 .env.example' }
  mkdirSync(runtimeRoot, { recursive: true })
  copyFileSync(envExamplePath, target)
  return { created: true, target }
}

export function syncCheryTemplate({ templateDir, runtimeRoot }) {
  const sourceRoot = resolve(templateDir)
  const targetRoot = resolve(runtimeRoot, '.chery')
  const manifestPath = join(targetRoot, MANIFEST_NAME)
  const report = {
    created: false,
    copied: [],
    updated: [],
    preserved: [],
    configMigrated: false,
    warnings: [],
  }
  if (!existsSync(sourceRoot)) {
    report.warnings.push(`模板目录不存在：${sourceRoot}`)
    return report
  }

  if (
    existsSync(targetRoot) &&
    (lstatSync(targetRoot).isSymbolicLink() || !lstatSync(targetRoot).isDirectory())
  ) {
    report.warnings.push(`运行时 .chery 不是可同步的真实目录：${targetRoot}`)
    return report
  }

  if (!existsSync(targetRoot)) {
    mkdirSync(runtimeRoot, { recursive: true })
    cpSync(sourceRoot, targetRoot, { recursive: true })
    const files = {}
    for (const absolute of walkFiles(sourceRoot)) {
      const rel = normalizedRelative(sourceRoot, absolute)
      if (!UNMANAGED_TEMPLATE_FILES.has(rel)) files[rel] = sha256(readFileSync(absolute))
    }
    writeManifest(manifestPath, {
      version: MANIFEST_VERSION,
      files,
      migrations: { [CONFIG_MIGRATION]: true },
      syncedAt: new Date().toISOString(),
    })
    report.created = true
    report.copied.push(...Object.keys(files))
    return report
  }

  const previous = readManifest(manifestPath)
  const nextFiles = {}
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  const backupRoot = join(targetRoot, 'backups', 'template', stamp)
  for (const source of walkFiles(sourceRoot)) {
    const rel = normalizedRelative(sourceRoot, source)
    if (UNMANAGED_TEMPLATE_FILES.has(rel)) continue
    const target = resolve(targetRoot, rel)
    if (
      !target.startsWith(`${targetRoot}${sep}`) ||
      hasSymlinkSegment(targetRoot, dirname(target))
    ) {
      report.preserved.push({ path: rel, reason: 'symlink-or-path-guard' })
      if (previous.files[rel]) nextFiles[rel] = previous.files[rel]
      continue
    }
    const sourceContent = readFileSync(source)
    const sourceHash = sha256(sourceContent)
    const previousHash = previous.files[rel]
    if (!existsSync(target)) {
      if (previousHash) {
        report.preserved.push({ path: rel, reason: 'user-deleted' })
        nextFiles[rel] = previousHash
      } else {
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(source, target)
        report.copied.push(rel)
        nextFiles[rel] = sourceHash
      }
      continue
    }
    if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) {
      report.preserved.push({ path: rel, reason: 'non-file-target' })
      if (previousHash) nextFiles[rel] = previousHash
      continue
    }
    const targetHash = sha256(readFileSync(target))
    const legacy = LEGACY_MANAGED_HASHES[rel]?.has(targetHash) === true
    if (targetHash === sourceHash) {
      nextFiles[rel] = sourceHash
    } else if (targetHash === previousHash || legacy) {
      replaceFile(target, sourceContent, join(backupRoot, rel))
      report.updated.push(rel)
      nextFiles[rel] = sourceHash
    } else {
      report.preserved.push({ path: rel, reason: 'user-modified' })
      if (previousHash) nextFiles[rel] = previousHash
    }
  }

  const migration = migrateBuiltInConfig(
    join(sourceRoot, 'config.yaml'),
    join(targetRoot, 'config.yaml'),
    backupRoot,
    previous.migrations,
  )
  report.configMigrated = migration.changed
  if (migration.warning) report.warnings.push(migration.warning)
  const migrations = { ...previous.migrations }
  if (migration.applied) migrations[CONFIG_MIGRATION] = true
  writeManifest(manifestPath, {
    version: MANIFEST_VERSION,
    files: nextFiles,
    migrations,
    syncedAt: new Date().toISOString(),
  })
  return report
}
