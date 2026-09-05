import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Electron task center window', () => {
  it('uses one managed, session-lived task center window', async () => {
    const main = await readFile(resolve(import.meta.dirname, '../../electron/main.ts'), 'utf8')

    expect(main).toContain("openAuxWindow({ kind: 'task-center' })")
    expect(main).toContain("keepAlive: req.kind === 'composer' || req.kind === 'task-center'")
  })
})
