import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('history drawer motion', () => {
  it('reuses a stack-level panel when the root conversation changes', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../../src/features/agent/drawer/HistoryDrawer.vue', import.meta.url)),
      'utf8',
    )
    const panel = source.match(/<HistoryDrawerPanel(?<body>[\s\S]*?)\/>/)?.groups?.body

    expect(panel).toContain('v-for="(cid, i) in stack"')
    expect(panel).toContain(':key="i"')
    expect(panel).toContain(':chat-id="cid"')
    expect(panel).not.toContain(':key="cid"')
  })
})
