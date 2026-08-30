import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createTempDir, cleanupTempDir, createTempFile } from '../../helpers/tempDir.js'
import { approvalPreview, approvalSnapshotMatches } from '@/agent/middleware/approvalPreview.js'

describe('approvalPreview', () => {
  it('builds a line-reviewable write preview and rejects a changed snapshot', () => {
    const dir = createTempDir()
    const file = createTempFile(dir, 'review.txt', 'one\ntwo\nthree\n')
    try {
      const preview = approvalPreview('write_file', JSON.stringify({ path: file, content: 'one\nnew\nthree\n' }))
      const payload = JSON.parse(preview.arguments).__filePreview
      expect(payload.files[0]).toMatchObject({ path: file, before: 'one\ntwo\nthree\n', after: 'one\nnew\nthree\n', kind: 'modify' })
      expect(preview.snapshot).toBeDefined()
      expect(approvalSnapshotMatches(preview.snapshot!)).toBe(true)
      fs.writeFileSync(file, 'changed by another writer', 'utf8')
      expect(approvalSnapshotMatches(preview.snapshot!)).toBe(false)
    } finally {
      cleanupTempDir(dir)
    }
  })

  it('previews asset replacement and archival without executing either operation', () => {
    const dir = createTempDir()
    const previousRoot = process.env.CHERY_DIR
    process.env.CHERY_DIR = dir
    const asset = `${dir}/.chery/prompt/example.md`
    fs.mkdirSync(`${dir}/.chery/prompt`, { recursive: true })
    fs.writeFileSync(asset, 'old prompt', 'utf8')
    try {
      const save = approvalPreview('config_manage', JSON.stringify({
        action: 'asset_save', assetPath: 'prompt/example.md', content: 'new prompt',
      }))
      const archived = approvalPreview('config_manage', JSON.stringify({
        action: 'asset_archive', assetPath: 'prompt/example.md',
      }))
      expect(JSON.parse(save.arguments).__filePreview.files[0]).toMatchObject({
        path: '.chery/prompt/example.md', before: 'old prompt', after: 'new prompt', kind: 'modify',
      })
      expect(JSON.parse(archived.arguments).__filePreview.files[0]).toMatchObject({
        path: '.chery/prompt/example.md', before: 'old prompt', after: '', kind: 'delete',
      })
      expect(fs.readFileSync(asset, 'utf8')).toBe('old prompt')
    } finally {
      if (previousRoot === undefined) delete process.env.CHERY_DIR
      else process.env.CHERY_DIR = previousRoot
      cleanupTempDir(dir)
    }
  })
})
