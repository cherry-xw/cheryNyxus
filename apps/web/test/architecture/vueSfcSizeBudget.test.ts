import { readFile, readdir } from 'node:fs/promises'
import { resolve, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE_ROOT = resolve(import.meta.dirname, '../../src')
const DEFAULT_LIMIT = 800
const LEGACY_LIMITS = new Map([
  ['features/agent/settings/tabs/agent/PresetsTab.vue', 983],
  ['features/agent/settings/tabs/tools/components/SkillImportDialog.vue', 980],
  ['features/agent/settings/tabs/tools/components/ImportPortalFrame.vue', 902],
])

async function vueFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = resolve(directory, entry.name)
      if (entry.isDirectory()) return vueFiles(path)
      return entry.isFile() && entry.name.endsWith('.vue') ? [path] : []
    }),
  )
  return nested.flat()
}

describe('Vue SFC size budget', () => {
  it('keeps components below 800 lines and freezes the three legacy exceptions', async () => {
    const violations: string[] = []
    for (const file of await vueFiles(SOURCE_ROOT)) {
      const name = relative(SOURCE_ROOT, file).replaceAll('\\', '/')
      const lineCount = (await readFile(file, 'utf8')).split(/\r?\n/).length
      const limit = LEGACY_LIMITS.get(name) ?? DEFAULT_LIMIT
      if (lineCount > limit) violations.push(`${name}: ${lineCount} > ${limit}`)
    }
    expect(violations).toEqual([])
  })
})
