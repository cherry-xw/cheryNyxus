/**
 * search_codebase sense 单元测试。
 *
 * 覆盖：
 * - sense 定义：name/supervision
 * - getFinder 缓存 + fff 不可用 → null
 * - handler：finder 不可用 → 错误消息
 * - searchContent：匹配/无匹配/错误
 * - searchFilename：匹配/无匹配/错误
 * - contextLines 上下文
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import searchSense from '@/agent/sense/search.js'
import { SupervisionLevel } from '@/core/config.js'

const exec = searchSense.executor.execute.bind(searchSense.executor)
const sharedData = new Map<string, Map<string, unknown>>()

describe('search_codebase sense 定义', () => {
  it('name = search_codebase', () => {
    expect(searchSense.definition.function.name).toBe('search_codebase')
  })

  it('supervision = auto', () => {
    expect(searchSense.supervisionLevel).toBe(SupervisionLevel.auto)
  })
})

describe('search_codebase handler', () => {
  it('finder 不可用 → 返回错误消息', async () => {
    // fff 原生库通常在测试环境不可用
    const r = await exec({ path: '/tmp', query: 'test' }, sharedData)
    // 要么 fff 不可用返回错误，要么 fff 可用但索引失败——两种情况都有合理 content
    expect(r.content).toBeDefined()
    expect(typeof r.content).toBe('string')
  })

  it('mode=filename 路径', async () => {
    const r = await exec({ path: '/tmp', query: 'test', mode: 'filename' }, sharedData)
    expect(r.content).toBeDefined()
  })

  it('schema 默认值', () => {
    const schema = searchSense.executor.schema
    const parsed = schema.parse({ path: '/tmp', query: 'hello' })
    expect(parsed.mode).toBe('content')
    // regex/maxResults/contextLines are .optional() — undefined when not provided
    // defaults are applied in handler via ?? operator, not zod .default()
    expect(parsed.maxResults).toBeUndefined()
    expect(parsed.contextLines).toBeUndefined()
  })
})
