import { describe, expect, it } from 'vitest'
import {
  isPrimaryField,
  isScalarValue,
  normalizeKey,
  parseJsonValue,
  prettyTranslatedJson,
  readableToolRun,
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

describe('readableToolRun', () => {
  const cases = [
    ['read_file', '读取文件', 'read', '{"path":"src/a.ts"}', '{"content":"one\\ntwo"}', '读取文件', 'src/a.ts', '已读取 2 行内容'],
    ['search_codebase', '搜索代码', 'read', '{"query":"toolCursor"}', '{"matches":[{},{}]}', '搜索代码', 'toolCursor', '找到结果 2 条'],
    ['write_file', '写入文件', 'write', '{"path":"src/a.ts"}', '{"updated":true}', '写入文件', 'src/a.ts', '已更新文件'],
    ['execute_command', '执行命令', 'exec', '{"command":"pnpm test"}', '{"exit_code":0,"stdout":"passed"}', '执行命令', 'pnpm test', '退出码 0：passed'],
    ['web_search', '网页搜索', 'web', '{"query":"Vue"}', '{"results":[{}]}', '搜索网页信息', 'Vue', '获得结果 1 条'],
    ['spawn_role', '委派角色', 'dispatch', '{"role":"reviewer","task":"检查协议"}', '{"message":"已启动"}', '派发子任务', 'reviewer', '已启动'],
    ['custom_tool', '自定义工具', 'other', '{"description":"整理数据"}', '{"message":"完成"}', '执行工具步骤', undefined, '完成'],
  ] as const

  it.each(cases)('explains %s in human terms', (name, label, type, args, result, intent, target, summary) => {
    const run = readableToolRun(name, label, type, 'completed', args, result)
    expect(run.intent).toBe(`已${intent}`)
    expect(run.target).toBe(target)
    expect(run.outcome).toBe('执行完成')
    expect(run.resultSummary).toBe(summary)
  })

  it.each([
    ['pending', '等待工具执行'],
    ['accepted', '工具正在运行，等待返回结果'],
    ['rejected', '本次操作已被拒绝'],
    ['error', '工具执行失败'],
  ] as const)('covers %s without inventing a result', (status, outcome) => {
    const run = readableToolRun('read_file', '读取文件', 'read', status, '{"path":"a.ts"}', null)
    expect(run.outcome).toBe(outcome)
    expect(run.resultSummary).toBeUndefined()
  })

  it('keeps real failures visible and falls back for malformed payloads', () => {
    const failed = readableToolRun('execute_command', '执行命令', 'exec', 'error', 'not-json', '{"stderr":"permission denied"}')
    expect(failed.resultSummary).toBe('permission denied')
    const unknown = readableToolRun('opaque', '未知工具', 'other', 'completed', '', 'not-json')
    expect(unknown.intent).toBe('已运行“未知工具”')
    expect(unknown.outcome).toBe('执行完成')
    expect(unknown.resultSummary).toBe('not-json')
  })

  it('turns config actions and patches into concrete user-visible work', () => {
    const get = readableToolRun('config_manage', 'config_manage', 'write', 'completed', '{"action":"get"}', '')
    expect(get.toolLabel).toBe('配置管理')
    expect(get.intent).toBe('已获取配置参数')
    const patch = readableToolRun(
      'config_manage',
      'config_manage',
      'write',
      'pending',
      '{"action":"patch","operations":[{"op":"putSenseGroup","name":"leader","senses":["read_file","write_file"]}]}',
      '',
    )
    expect(patch.intent).toBe('准备修改配置参数')
    expect(patch.changes).toEqual([
      { label: '工具组', detail: '将工具组“leader”设置为：读取文件、写入文件' },
    ])
  })
})
