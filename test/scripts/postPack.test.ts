import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import afterPack from '../../web/scripts/post-pack.mjs'

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'chery-post-pack-'))
  roots.push(root)
  return root
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, 'utf8')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('electron afterPack', () => {
  it('keeps immutable resources and removes stale runtime copies', async () => {
    const appOutDir = tempRoot()
    write(join(appOutDir, 'resources', '.env.example'), 'API_KEY=\n')
    write(join(appOutDir, 'resources', '.chery.template', 'config.yaml'), 'global: {}\n')
    write(join(appOutDir, '.env'), 'API_KEY=user-secret\n')
    write(join(appOutDir, '.chery', 'custom.txt'), 'user copy in stale build output')

    await afterPack({ appOutDir, electronPlatformName: 'test' })

    expect(existsSync(join(appOutDir, '.env'))).toBe(false)
    expect(existsSync(join(appOutDir, '.chery'))).toBe(false)
    expect(readFileSync(join(appOutDir, 'resources', '.env.example'), 'utf8')).toBe('API_KEY=\n')
    expect(
      readFileSync(join(appOutDir, 'resources', '.chery.template', 'config.yaml'), 'utf8'),
    ).toBe('global: {}\n')
  })

  it('fails the package when required templates are missing', async () => {
    const appOutDir = tempRoot()
    mkdirSync(join(appOutDir, 'resources'), { recursive: true })

    await expect(afterPack({ appOutDir, electronPlatformName: 'test' })).rejects.toThrow(
      'required file is missing',
    )
  })
})
