import { describe, expect, it } from 'vitest'
import {
  diffFileLines,
  fileChangePreview,
} from '../../src/features/agent/cards/fileChangeDiff'

describe('file change diff', () => {
  it('parses create, modify and delete previews while preserving preview errors', () => {
    const preview = fileChangePreview(JSON.stringify({
      path: 'original argument',
      __filePreview: {
        files: [
          { path: 'new.txt', before: '', after: 'new', kind: 'create' },
          { path: 'edit.txt', before: 'old', after: 'new', kind: 'modify' },
          { path: 'old.txt', before: 'old', after: '', kind: 'delete' },
        ],
        error: 'one target could not be previewed',
      },
    }))

    expect(preview).toEqual({
      files: [
        { path: 'new.txt', before: '', after: 'new', kind: 'create' },
        { path: 'edit.txt', before: 'old', after: 'new', kind: 'modify' },
        { path: 'old.txt', before: 'old', after: '', kind: 'delete' },
      ],
      error: 'one target could not be previewed',
    })
    expect(fileChangePreview('{"__filePreview":{"error":"preview failed"}}')).toEqual({
      files: [],
      error: 'preview failed',
    })
  })

  it('produces line-level additions, removals and unchanged context without phantom empty lines', () => {
    expect(diffFileLines('one\ntwo\nthree', 'one\nnew\nthree')).toEqual([
      { kind: 'same', text: 'one' },
      { kind: 'add', text: 'new' },
      { kind: 'remove', text: 'two' },
      { kind: 'same', text: 'three' },
    ])
    expect(diffFileLines('', 'created')).toEqual([{ kind: 'add', text: 'created' }])
    expect(diffFileLines('deleted', '')).toEqual([{ kind: 'remove', text: 'deleted' }])
  })
})
