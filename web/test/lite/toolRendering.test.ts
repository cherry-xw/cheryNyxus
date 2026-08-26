import { describe, expect, it } from 'vitest'
import {
  isPrimaryField,
  isScalarValue,
  normalizeKey,
  parseJsonValue,
  prettyTranslatedJson,
  scalarText,
  toObjectEntries,
  translateKey,
} from '../../src/features/lite/toolRendering'

describe('translateKey English→Chinese key translation', () => {
  it('translates common argument/result keys', () => {
    expect(translateKey('command')).toBe('命令')
    expect(translateKey('description')).toBe('说明')
    expect(translateKey('path')).toBe('路径')
    expect(translateKey('file_path')).toBe('文件路径')
    expect(translateKey('content')).toBe('内容')
    expect(translateKey('exit_code')).toBe('退出码')
    expect(translateKey('max_results')).toBe('结果上限')
    expect(translateKey('prompt')).toBe('任务说明')
    expect(translateKey('status')).toBe('状态')
  })

  it('normalizes camelCase / dashed keys before lookup', () => {
    expect(normalizeKey('filePath')).toBe('file_path')
    expect(translateKey('filePath')).toBe('文件路径')
    expect(translateKey('maxResults')).toBe('结果上限')
    expect(translateKey('exitCode')).toBe('退出码')
    expect(translateKey('working-directory')).toBe('工作目录')
    expect(translateKey('WORKING_DIRECTORY')).toBe('工作目录')
  })

  it('falls back to the original key when unknown', () => {
    expect(translateKey('something_custom_xyz')).toBe('something_custom_xyz')
    expect(translateKey('')).toBe('')
  })
})

describe('parseJsonValue', () => {
  it('parses JSON strings and passes through non-strings', () => {
    expect(parseJsonValue('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonValue(42)).toBe(42)
    expect(parseJsonValue({ a: 1 })).toEqual({ a: 1 })
  })

  it('returns undefined for invalid/empty/null', () => {
    expect(parseJsonValue('not json')).toBeUndefined()
    expect(parseJsonValue('  ')).toBeUndefined()
    expect(parseJsonValue(null)).toBeUndefined()
    expect(parseJsonValue(undefined)).toBeUndefined()
    expect(parseJsonValue('')).toBeUndefined()
  })
})

describe('prettyTranslatedJson recursive key translation', () => {
  it('translates nested object and array keys, keeping scalar leaves', () => {
    const out = prettyTranslatedJson({
      command: 'ls',
      env: { maxResults: 5, cwd: '/tmp' },
      args: [{ filePath: 'a.ts', contextLines: 3 }],
    })
    expect(out).toContain('"命令": "ls"')
    expect(out).toContain('"环境变量"')
    expect(out).toContain('"结果上限": 5')
    expect(out).toContain('"工作目录": "/tmp"')
    expect(out).toContain('"文件路径": "a.ts"')
  })

  it('returns scalar as-is', () => {
    expect(prettyTranslatedJson('text')).toBe('text')
    expect(prettyTranslatedJson(3)).toBe('3')
    expect(prettyTranslatedJson(null)).toBe('')
  })
})

describe('toObjectEntries', () => {
  it('maps object fields to translated entries in order', () => {
    const entries = toObjectEntries({ command: 'ls', fooBar: 1 })
    expect(entries).toEqual([
      { key: 'command', label: '命令', value: 'ls' },
      { key: 'fooBar', label: 'fooBar', value: 1 },
    ])
  })

  it('returns null for non-object values', () => {
    expect(toObjectEntries('str')).toBeNull()
    expect(toObjectEntries([1, 2])).toBeNull()
    expect(toObjectEntries(null)).toBeNull()
    expect(toObjectEntries(undefined)).toBeNull()
  })
})

describe('isPrimaryField per tool type', () => {
  it('highlights the expected fields for each tool type', () => {
    expect(isPrimaryField('exec', 'command')).toBe(true)
    expect(isPrimaryField('exec', 'description')).toBe(true)
    expect(isPrimaryField('exec', 'url')).toBe(false)
    expect(isPrimaryField('read', 'path')).toBe(true)
    expect(isPrimaryField('read', 'query')).toBe(true)
    expect(isPrimaryField('write', 'content')).toBe(true)
    expect(isPrimaryField('web', 'url')).toBe(true)
    expect(isPrimaryField('dispatch', 'prompt')).toBe(true)
    expect(isPrimaryField('dispatch', 'command')).toBe(false)
  })
})

describe('isScalarValue / scalarText', () => {
  it('treats primitives as scalar and objects as nested', () => {
    expect(isScalarValue('x')).toBe(true)
    expect(isScalarValue(1)).toBe(true)
    expect(isScalarValue(true)).toBe(true)
    expect(isScalarValue(null)).toBe(true)
    expect(isScalarValue({ a: 1 })).toBe(false)
    expect(isScalarValue([1])).toBe(false)
  })

  it('stringifies scalar leaves', () => {
    expect(scalarText('x')).toBe('x')
    expect(scalarText(5)).toBe('5')
    expect(scalarText(false)).toBe('false')
    expect(scalarText(null)).toBe('')
  })
})
