import { describe, expect, it } from 'vitest'
import { instructionQuery } from '../../src/features/agent/composer/instructionQuery'
import {
  serializeFileMention,
  splitCommandPrompt,
  canReferenceFile,
} from '../../src/features/agent/composables/commands'

describe('workbench reference input', () => {
  it.each(['/', '@', '&'])(
    'opens %s at a word boundary and locates the replacement span',
    (trigger) => {
      expect(instructionQuery('说明 ' + trigger + 'abc 后文', 7)).toEqual({
        trigger,
        query: 'abc',
        start: 3,
        end: 7,
      })
    },
  )
  it('keeps directory case and spaces without treating path slashes as commands', () => {
    const text = '&My Project/Src/Some File.ts'
    expect(instructionQuery(text, text.length)).toMatchObject({
      trigger: '&',
      query: 'My Project/Src/Some File.ts',
    })
    expect(instructionQuery('https://example.com/a', 21)).toBeNull()
    expect(instructionQuery('mail@host', 9)).toBeNull()
    expect(instructionQuery('[[file:src/a.ts]]', 17)).toBeNull()
  })
  it('serializes files and folders as paths and restores mixed message segments', () => {
    const file = serializeFileMention({ path: 'src/My File.ts' })
    const folder = serializeFileMention({ path: 'src', kind: 'directory' })
    expect(file).toBe('[[file:src/My File.ts]]')
    expect(folder).toBe('[[file:src/]]')
    expect(
      splitCommandPrompt(`查看 ${file} ${folder} [[role:@开发]] [[command:/compact]]`).filter(
        (segment) => segment.type !== 'text',
      ),
    ).toEqual([
      { type: 'file', value: 'src/My File.ts' },
      { type: 'file', value: 'src/' },
      { type: 'role', value: '@开发' },
      { type: 'command', value: '/compact' },
    ])
  })
  it('rejects paths that would break token boundaries', () => {
    expect(canReferenceFile('file].txt')).toBe(false)
    expect(() => serializeFileMention({ path: 'file].txt' })).toThrow()
  })
})
