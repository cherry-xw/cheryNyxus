/**
 * hooks matcher 单测：matches / evalIf / expandCommandTemplate 纯函数。
 */
import { describe, it, expect } from 'vitest'
import { matches, evalIf, expandCommandTemplate } from '@/agent/hooks/matcher.js'

describe('matches', () => {
  it('undefined / "*" / "" 匹配全部', () => {
    expect(matches(undefined, 'anthropic')).toBe(true)
    expect(matches('*', 'anthropic')).toBe(true)
    expect(matches('', 'anthropic')).toBe(true)
  })

  it('仅精确字符 -> 精确匹配', () => {
    expect(matches('anthropic', 'anthropic')).toBe(true)
    expect(matches('anthropic', 'openai')).toBe(false)
  })

  it('| 或 , 分隔的多精确字符串集合', () => {
    expect(matches('openai|anthropic', 'anthropic')).toBe(true)
    expect(matches('openai|anthropic', 'openai')).toBe(true)
    expect(matches('openai|anthropic', 'ollama')).toBe(false)
    expect(matches('openai, anthropic', 'anthropic')).toBe(true) // 含空格 trim
  })

  it('含正则元字符 -> JS 正则（unanchored，除非显式 ^/$）', () => {
    expect(matches('^claude', 'claude-sonnet-4')).toBe(true) // ^ 锚定开头
    expect(matches('^claude', 'anthropic-claude')).toBe(false) // ^ 锚定，不匹配
    expect(matches('cl.*de', 'anthropic-claude')).toBe(true) // 含 .* 元字符 → unanchored 正则
    expect(matches('mcp__.*__write', 'mcp__memory__write_file')).toBe(true)
    expect(matches('mcp__.*__write', 'mcp__memory__read_file')).toBe(false)
  })

  it('非法正则降级精确匹配', () => {
    expect(matches('[invalid', 'x')).toBe(false) // 不等 'x'
    expect(matches('[invalid', '[invalid')).toBe(true)
  })
})

describe('evalIf', () => {
  const ctx = {
    event: 'PreLLMRequest',
    payload: { provider: 'anthropic', thinking: 'high', model: 'claude-sonnet-4' },
    ctx: { brain: 'main' },
  }

  it('空表达式 -> true', () => {
    expect(evalIf('', ctx)).toBe(true)
    expect(evalIf('   ', ctx)).toBe(true)
  })

  it('== 字符串字面量（双引号）', () => {
    expect(evalIf('payload.provider == "anthropic"', ctx)).toBe(true)
    expect(evalIf('payload.provider == "openai"', ctx)).toBe(false)
  })

  it('== 字符串字面量（单引号）', () => {
    expect(evalIf("payload.thinking == 'high'", ctx)).toBe(true)
  })

  it('!= 字符串字面量', () => {
    expect(evalIf('payload.provider != "openai"', ctx)).toBe(true)
    expect(evalIf('payload.provider != "anthropic"', ctx)).toBe(false)
  })

  it('单独字段 -> truthy 检查', () => {
    expect(evalIf('payload.provider', ctx)).toBe(true)
    expect(evalIf('payload.missing', ctx)).toBe(false)
  })

  it('点号路径访问嵌套字段', () => {
    expect(evalIf('ctx.brain == "main"', ctx)).toBe(true)
    expect(evalIf('payload.model == "claude-sonnet-4"', ctx)).toBe(true)
  })

  it('不支持的语法 -> false（保守拒绝）', () => {
    expect(evalIf('payload.x > 5 && payload.y < 10', ctx)).toBe(false)
    expect(evalIf('foo(bar)', ctx)).toBe(false)
  })
})

describe('expandCommandTemplate', () => {
  it('${VAR} 替换为环境变量值', () => {
    expect(
      expandCommandTemplate('${CHERY_DIR}/hooks/foo.sh', { CHERY_DIR: '/tmp/chery' }),
    ).toBe('/tmp/chery/hooks/foo.sh')
  })

  it('未定义的 VAR -> 空字符串', () => {
    expect(expandCommandTemplate('${MISSING}/foo.sh', {})).toBe('/foo.sh')
  })

  it('无 ${} 形式 -> 原样返回', () => {
    expect(expandCommandTemplate('echo hello', {})).toBe('echo hello')
  })

  it('多个 ${VAR} 全替换', () => {
    expect(
      expandCommandTemplate('${A}/${B}/x', { A: 'a', B: 'b' }),
    ).toBe('a/b/x')
  })

  it('不递归（替换一次）', () => {
    expect(
      expandCommandTemplate('${A}', { A: '${B}', B: 'c' }),
    ).toBe('${B}')
  })
})