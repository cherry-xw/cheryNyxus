import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import config from '@/utils/config.js'
import { compileSenses } from '@/core/sense/compiler/index.js'
import { resolveSenseArtifactPaths } from '@/core/sense/artifactPaths.js'
import { prepareSenseSourceReload, reloadSenses } from '@/agent/sense/index.js'
import { getSense, resetSenses } from '@/core/sense/index.js'

// Redirect only the shared default location: compilation, hot apply and reload
// still exercise their real production code without writing repository artifacts.
vi.mock('@/core/sense/artifactPaths.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/core/sense/artifactPaths.js')>()
  return { ...original, resolveSenseArtifactPaths: vi.fn(original.resolveSenseArtifactPaths) }
})

const originalSource = config.global.senses_dir
const roots: string[] = []
let transaction: Awaited<ReturnType<typeof prepareSenseSourceReload>> | undefined

afterEach(() => {
  transaction?.dispose()
  transaction = undefined
  config.global.senses_dir = originalSource
  resetSenses()
  vi.mocked(resolveSenseArtifactPaths).mockReset()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'chery-sense-path-regression-'))
  roots.push(root)
  const source = join(root, 'source')
  const distDir = join(root, 'backend', 'dist')
  mkdirSync(source, { recursive: true })
  config.global.senses_dir = source
  const paths = { distDir, sensesDir: join(distDir, 'senses'), tempDir: join(distDir, '.sense-temp') }
  vi.mocked(resolveSenseArtifactPaths).mockReturnValue(paths)
  return { root, source, ...paths }
}

function writeSource(source: string, version: string) {
  writeFileSync(join(source, 'path_probe.ts'), `
import { z } from 'zod'
const Schema = z.object({ text: z.string() });
export default sense('path_probe', 'temporary path probe', Schema,
  async (input) => ({ content: '${version}:' + input.text, hash: '' }));
`)
}

async function executeProbe() {
  const probe = getSense('path_probe')
  expect(probe).toBeDefined()
  return probe!.executor.execute(probe!.executor.schema.parse({ text: 'live' }), new Map())
}

describe('shared default Sense artifact location', () => {
  it('compiles new source, reloads it, hot applies it and reloads the published version', async () => {
    const paths = workspace()
    writeSource(paths.source, 'v1')
    const summary = await compileSenses()
    expect(summary.failed).toEqual([])
    expect(summary.succeeded.map((entry) => entry.compiledPath)).toEqual([join(paths.sensesDir, 'path_probe.js')])
    expect(existsSync(paths.tempDir)).toBe(false)
    await reloadSenses()
    expect(await executeProbe()).toEqual({ content: 'v1:live', hash: '' })

    writeSource(paths.source, 'v2')
    transaction = await prepareSenseSourceReload()
    expect(await executeProbe()).toEqual({ content: 'v1:live', hash: '' })
    transaction.apply()
    expect(await executeProbe()).toEqual({ content: 'v2:live', hash: '' })
    resetSenses()
    await reloadSenses()
    expect(await executeProbe()).toEqual({ content: 'v2:live', hash: '' })

    transaction.rollback()
    resetSenses()
    await reloadSenses()
    expect(await executeProbe()).toEqual({ content: 'v1:live', hash: '' })
    transaction.dispose()
    expect(readdirSync(paths.distDir)).toEqual(['senses'])
    expect(existsSync(join(paths.root, 'dist'))).toBe(false)
    expect(resolveSenseArtifactPaths).toHaveBeenCalled()
  })

  it('keeps the published version loadable after failed source hot apply', async () => {
    const paths = workspace()
    writeSource(paths.source, 'working')
    await compileSenses()
    await reloadSenses()
    writeFileSync(join(paths.source, 'path_probe.ts'), 'const broken = ;')
    await expect(prepareSenseSourceReload()).rejects.toThrow()
    resetSenses()
    await reloadSenses()
    expect(await executeProbe()).toEqual({ content: 'working:live', hash: '' })
    expect(readdirSync(paths.distDir)).toEqual(['senses'])
  })
})
