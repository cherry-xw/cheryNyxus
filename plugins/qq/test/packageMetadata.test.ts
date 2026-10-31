import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import { expect, it } from 'vitest'

it('keeps the QQ install, page resource and package versions identical', () => {
  const manifest = load(readFileSync(new URL('../config.yaml', import.meta.url), 'utf8')) as { id: string; version: string; ui: Array<{ resourceVersion: string }> }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  expect(manifest.id).toBe(pkg.name)
  expect(manifest.version).toBe(pkg.version)
  expect(manifest.ui).toHaveLength(1)
  expect(manifest.ui[0]?.resourceVersion).toBe(pkg.version)
})
