import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

it('keeps the QQ install manifest and package version identical', () => {
  const manifest = load(readFileSync(new URL('../config.yaml', import.meta.url), 'utf8')) as { id: string; version: string }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest.id).toBe(pkg.name)
  expect(manifest.version).toBe(pkg.version)
})
