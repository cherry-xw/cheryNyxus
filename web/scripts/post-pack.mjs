#!/usr/bin/env node
/**
 * electron-builder afterPack hook.
 *
 * Release artifacts carry immutable seeds only under `resources/`. Runtime `.env` and `.chery`
 * are created/upgraded on application startup, so an installer upgrade cannot overwrite user data.
 */
import { existsSync, lstatSync, rmSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

function assertResource(path, kind) {
  if (!existsSync(path)) throw new Error(`[post-pack] required ${kind} is missing: ${path}`)
  const stat = lstatSync(path)
  if (kind === 'file' && !stat.isFile()) {
    throw new Error(`[post-pack] required file is invalid: ${path}`)
  }
  if (kind === 'directory' && !stat.isDirectory()) {
    throw new Error(`[post-pack] required directory is invalid: ${path}`)
  }
}

function assertSafeChild(root, target) {
  const rel = relative(root, target)
  if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) {
    throw new Error(`[post-pack] refusing to remove path outside appOutDir: ${target}`)
  }
}

export default async function afterPack(context) {
  const appOutDir = resolve(context.appOutDir)
  console.log(
    `[post-pack] platform=${context.electronPlatformName ?? 'unknown'} appOutDir=${appOutDir}`,
  )

  const resourcesDir = join(appOutDir, 'resources')
  assertResource(join(resourcesDir, '.env.example'), 'file')
  assertResource(join(resourcesDir, '.chery.template'), 'directory')

  // A reused build directory may contain copies produced by older hooks. Remove only those exact
  // build-output paths after validating the immutable resources that replace them.
  for (const stale of [join(appOutDir, '.env'), join(appOutDir, '.chery')]) {
    assertSafeChild(appOutDir, stale)
    if (!existsSync(stale)) continue
    rmSync(stale, { recursive: true, force: true })
    console.log(`[post-pack] removed stale runtime copy: ${stale}`)
  }

  console.log('[post-pack] immutable runtime templates verified')
}
