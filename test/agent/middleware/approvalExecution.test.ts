import fs from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { bootstrapForTests, createAgent, runSendWithApproval } from '../helpers/agentHarness.js'
import { senseAccepts } from '../helpers/chunkAssert.js'
import { addMockBrain, scriptItem } from '../helpers/mockScripts.js'
import { cleanupTempDir, createTempDir } from '../../helpers/tempDir.js'

describe('approval display and execution arguments', () => {
  beforeAll(async () => {
    await bootstrapForTests()
  })

  it('shows enriched review arguments but executes the original tool arguments', async () => {
    const dir = createTempDir()
    const file = `${dir}/approved.txt`
    const original = { path: file, content: 'approved content' }
    const brain = addMockBrain('approval-original-args', {
      repeat: 'last',
      script: [
        scriptItem({
          content: 'write after approval',
          senseCalls: [{ id: 'approved-write', name: 'write_file', arguments: JSON.stringify(original) }],
        }),
        scriptItem({ content: 'done' }),
      ],
    })
    try {
      const agent = createAgent({ brain, senseGroup: 'confirm_senses' })
      const chunks = await runSendWithApproval(agent, 'write the file', (pending) => {
        const displayed = JSON.parse(pending.arguments)
        expect(displayed).toMatchObject(original)
        expect(displayed.__filePreview.files[0]).toMatchObject({
          path: file,
          before: '',
          after: original.content,
          kind: 'create',
        })
        return 'accept'
      })

      expect(senseAccepts(chunks).map((chunk) => chunk.id)).toContain('approved-write')
      expect(fs.readFileSync(file, 'utf8')).toBe(original.content)
    } finally {
      cleanupTempDir(dir)
    }
  })
})
