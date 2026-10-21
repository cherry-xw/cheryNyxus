import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { backendComponentRoot, initializeBackendEnvironment } from '../../../../scripts/lib/backend-layout.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function layout() {
  const root = mkdtempSync('/tmp/opencode/backend-layout-test-'); roots.push(root)
  const backend = join(root, 'apps/backend'); mkdirSync(backend, { recursive: true })
  return { root, backend, entry: pathToFileURL(join(backend, 'src/utils/config.ts')).href }
}

it('resolves source, build and Manager entries to the same component without using cwd', () => {
  const { root, backend, entry } = layout()
  for (const url of [entry, pathToFileURL(join(backend, 'dist/index.js')).href,
    pathToFileURL(join(root, 'apps/manager/src/index.ts')).href, pathToFileURL(join(root, 'apps/manager/server-dist/index.js')).href]) {
    expect(backendComponentRoot(url)).toBe(backend)
    expect(initializeBackendEnvironment(url, {}).runtimeRoot).toBe(backend)
  }
})

it('loads only Backend env, preserves inherited values and keeps deployment tokens out of general env', () => {
  const { root, backend, entry } = layout()
  writeFileSync(join(root, '.env'), 'ROOT_ONLY=wrong\nAPI_KEY=wrong\n')
  writeFileSync(join(backend, '.env'), 'API_KEY=local-key\nLOCAL_ONLY=loaded\nQQBOT_PLATFORM_TOKEN=not-general\n')
  const env: NodeJS.ProcessEnv = { API_KEY: 'inherited-key' }
  const value = initializeBackendEnvironment(entry, env)
  expect(env).toMatchObject({ API_KEY: 'inherited-key', LOCAL_ONLY: 'loaded', CHERY_DIR: backend })
  expect(env.ROOT_ONLY).toBeUndefined(); expect(env.QQBOT_PLATFORM_TOKEN).toBeUndefined()
  expect(value.templateDir).toBe(join(backend, '.chery.template'))
  expect(readFileSync(join(backend, '.env'), 'utf8')).toContain('API_KEY=local-key')
})

it('supports an explicit deployment root/env without creating repo-root data or changing its environment file', () => {
  const { root, backend, entry } = layout()
  const file = join(root, 'deployment.env')
  writeFileSync(file, 'CHERY_DIR=./runtime\nAPI_KEY=deployment-key\n')
  const env: NodeJS.ProcessEnv = { CHERY_ENV_FILE: file }
  expect(initializeBackendEnvironment(entry, env)).toMatchObject({ runtimeRoot: join(root, 'runtime'), envFile: file, templateDir: join(backend, '.chery.template') })
  expect(env.API_KEY).toBe('deployment-key')
  expect(existsSync(join(root, '.chery'))).toBe(false)
  expect(existsSync(join(backend, '.env'))).toBe(false)
  expect(() => initializeBackendEnvironment(entry, { CHERY_ENV_FILE: '' })).toThrow()
})
