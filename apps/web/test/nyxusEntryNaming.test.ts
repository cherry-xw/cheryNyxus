import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  resolve(process.cwd(), 'apps/web/src/features/pets/nyxus/components/NyxusCore.vue'),
  'utf8',
)

describe('cheryNyxus entry naming', () => {
  it('uses the formal name in every accessible entry label', () => {
    const page = readFileSync(resolve(process.cwd(), 'apps/web/index.html'), 'utf8')
    expect([...page.matchAll(/<title>([^<]+)<\/title>/g)].map((match) => match[1])).toEqual(['cheryNyxus'])
    expect([...source.matchAll(/\baria-label="([^"]+)"/g)].map((match) => match[1])).toEqual([
      '关闭 cheryNyxus 工具',
      'cheryNyxus 入口',
      '打开 cheryNyxus',
    ])
  })

  it('uses the formal name in every entry diagnostic and fallback error', () => {
    const diagnostics = [...source.matchAll(/console\.error\('([^']+)'/g)].map((match) => match[1])
    expect(diagnostics).toHaveLength(3)
    expect(diagnostics.every((message) => message.startsWith('[cheryNyxus] '))).toBe(true)
    expect(source).toContain("'打开 cheryNyxus 失败'")
    expect(source).toContain("'加载 cheryNyxus 会话列表失败'")
  })
})
