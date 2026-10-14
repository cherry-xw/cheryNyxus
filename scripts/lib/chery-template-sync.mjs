import {
  copyFileSync,
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
import { replaceConfigText, withConfigTransactionSync } from './config-transaction.mjs'

const MANIFEST_NAME = '.template-manifest.json'
const MANIFEST_VERSION = 1
const UNMANAGED_TEMPLATE_FILES = new Set(['config.yaml', MANIFEST_NAME])

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
  if (!existsSync(path)) return { version: MANIFEST_VERSION, files: {} }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    if (value?.version !== MANIFEST_VERSION || typeof value.files !== 'object') {
      return { version: MANIFEST_VERSION, files: {} }
    }
    return {
      version: MANIFEST_VERSION,
      files: value.files ?? {},
    }
  } catch {
    return { version: MANIFEST_VERSION, files: {} }
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

export function ensureEnvSeed({ envExamplePath, runtimeRoot }) {
  const target = resolve(runtimeRoot, '.env')
  if (existsSync(target)) return { created: false, target }
  if (!existsSync(envExamplePath)) return { created: false, target, warning: '缺少 .env.example' }
  mkdirSync(runtimeRoot, { recursive: true })
  copyFileSync(envExamplePath, target)
  return { created: true, target }
}

export function syncCheryTemplate(options) {
  const target = resolve(options.runtimeRoot, '.chery')
  const fresh = !existsSync(target)
  if (existsSync(target) && (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory())) {
    return syncCheryTemplateLocked(options)
  }
  return withConfigTransactionSync(join(target, 'config.yaml'), () => syncCheryTemplateLocked(options, fresh))
}

function syncCheryTemplateLocked({ templateDir, runtimeRoot }, fresh = false) {
  const sourceRoot = resolve(templateDir)
  const targetRoot = resolve(runtimeRoot, '.chery')
  const manifestPath = join(targetRoot, MANIFEST_NAME)
  const report = {
    created: false,
    copied: [],
    updated: [],
    preserved: [],
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

  if (fresh && !existsSync(join(targetRoot, 'config.yaml'))) {
    mkdirSync(targetRoot, { recursive: true })
    for (const absolute of walkFiles(sourceRoot)) {
      const rel = normalizedRelative(sourceRoot, absolute)
      const target = join(targetRoot, rel)
      if (rel === 'config.yaml') {
        replaceConfigText(target, readFileSync(absolute, 'utf8'), '')
      } else if (!existsSync(target) && !hasSymlinkSegment(targetRoot, dirname(target))) {
        mkdirSync(dirname(target), { recursive: true })
        copyFileSync(absolute, target, 1)
      }
    }
    const files = {}
    for (const absolute of walkFiles(sourceRoot)) {
      const rel = normalizedRelative(sourceRoot, absolute)
      if (!UNMANAGED_TEMPLATE_FILES.has(rel)) files[rel] = sha256(readFileSync(absolute))
    }
    writeManifest(manifestPath, {
      version: MANIFEST_VERSION,
      files,
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
    if (targetHash === sourceHash) {
      nextFiles[rel] = sourceHash
    } else if (targetHash === previousHash) {
      replaceFile(target, sourceContent, join(backupRoot, rel))
      report.updated.push(rel)
      nextFiles[rel] = sourceHash
    } else {
      report.preserved.push({ path: rel, reason: 'user-modified' })
      if (previousHash) nextFiles[rel] = previousHash
    }
  }

  writeManifest(manifestPath, {
    version: MANIFEST_VERSION,
    files: nextFiles,
    syncedAt: new Date().toISOString(),
  })
  return report
}
