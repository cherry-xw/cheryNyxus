import fs from 'node:fs'
import path from 'node:path'
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
      expect(save.snapshot?.path).toBe(path.resolve(asset))
      expect(approvalSnapshotMatches(save.snapshot!)).toBe(true)
      fs.writeFileSync(asset, 'changed after review', 'utf8')
      expect(approvalSnapshotMatches(save.snapshot!)).toBe(false)
    } finally {
      if (previousRoot === undefined) delete process.env.CHERY_DIR
      else process.env.CHERY_DIR = previousRoot
      cleanupTempDir(dir)
    }
  })

  it('builds a config patch preview without changing the config on disk', () => {
    const dir = createTempDir()
    const previousRoot = process.env.CHERY_DIR
    process.env.CHERY_DIR = dir
    const configDir = path.join(dir, '.chery')
    const configFile = path.join(configDir, 'config.yaml')
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(
      configFile,
      'global:\n  supervision: smart\nllm:\n  brain:\n    test:\n      provider: mock\n      model: test\n',
      'utf8',
    )
    try {
      const before = fs.readFileSync(configFile, 'utf8')
      const preview = approvalPreview('config_manage', JSON.stringify({
        action: 'patch',
        operations: [{ op: 'putSenseGroup', name: 'leader', senses: ['read_file'] }],
      }))
      const file = JSON.parse(preview.arguments).__filePreview.files[0]

      expect(file).toMatchObject({ path: '.chery/config.yaml', kind: 'modify' })
      expect(file.before).not.toBe(file.after)
      expect(file.after).toContain('sense_groups')
      expect(preview.snapshot).toBeUndefined()
      expect(fs.readFileSync(configFile, 'utf8')).toBe(before)
    } finally {
      if (previousRoot === undefined) delete process.env.CHERY_DIR
      else process.env.CHERY_DIR = previousRoot
      cleanupTempDir(dir)
    }
  })

  it.each([
    ['invalid config operation', 'config_manage', { action: 'patch', operations: [{ op: 'unknown' }] }],
    ['asset path traversal', 'config_manage', { action: 'asset_save', assetPath: '../config.yaml', content: 'x' }],
  ])('returns a display error for %s', (_label, name, args) => {
    const preview = approvalPreview(name, JSON.stringify(args))
    expect(JSON.parse(preview.arguments).__filePreview.error).toEqual(expect.any(String))
    expect(preview.snapshot).toBeUndefined()
  })

  it('reports oversized and non-file targets without reading or changing them', () => {
    const dir = createTempDir()
    const oversized = path.join(dir, 'oversized.txt')
    const folder = path.join(dir, 'folder')
    fs.writeFileSync(oversized, Buffer.alloc(1024 * 1024 + 1, 97))
    fs.mkdirSync(folder)
    try {
      for (const target of [oversized, folder]) {
        const preview = approvalPreview(
          'write_file',
          JSON.stringify({ path: target, content: 'replacement' }),
        )
        expect(JSON.parse(preview.arguments).__filePreview.error).toEqual(expect.any(String))
        expect(preview.snapshot).toBeUndefined()
      }
      expect(fs.statSync(oversized).size).toBe(1024 * 1024 + 1)
      expect(fs.statSync(folder).isDirectory()).toBe(true)
    } finally {
      cleanupTempDir(dir)
    }
  })
})
