/**
 * service/sense docs 测试：sense.tools.docs handler（handleSenseToolDocs）。
 *
 * 覆盖：
 * - 不传 tools / 空数组 = 全量返回，且与 BUILTIN_SENSE_TOOLS 一一对应（doc 非空）
 * - 传 tools = 按 name 列表过滤，未知 name 自动忽略
 */
import { describe, it, expect } from 'vitest'
import { handleSenseToolDocs } from '@/service/sense/list.js'
import { BUILTIN_SENSE_TOOLS } from '@/agent/sense/index.js'

/** handler 未使用 ctx，用最小桩即可。 */
const ctx = {} as never

describe('sense.tools.docs', () => {
  it('不传 tools → 全量返回，name 与 BUILTIN_SENSE_TOOLS 一致且 doc 非空', async () => {
    const res = await handleSenseToolDocs(ctx, {})
    expect(res.docs.map((d) => d.name)).toEqual(BUILTIN_SENSE_TOOLS.map((t) => t.name))
    for (const d of res.docs) {
      expect(d.doc.length).toBeGreaterThan(0)
      // 完整说明应包含作用/能力/边界/注意分节
      expect(d.doc).toContain('【作用】')
      expect(d.doc).toContain('【能力】')
      expect(d.doc).toContain('【边界】')
      expect(d.doc).toContain('【注意】')
    }
  })

  it('tools=[] → 等价全量返回', async () => {
    const res = await handleSenseToolDocs(ctx, { tools: [] })
    expect(res.docs).toHaveLength(BUILTIN_SENSE_TOOLS.length)
  })

  it('传 tools 列表 → 只返回对应工具，未知 name 自动忽略', async () => {
    const res = await handleSenseToolDocs(ctx, { tools: ['execute_command', 'read_file', 'no_such_tool'] })
    expect(res.docs.map((d) => d.name)).toEqual(['execute_command', 'read_file'])
  })

  it('sense.tools 不携带 doc（保持轻量）', async () => {
    const { handleSenseTools } = await import('@/service/sense/list.js')
    const res = await handleSenseTools(ctx, {})
    expect(res.tools.every((t) => !('doc' in t))).toBe(true)
    expect(res.tools).toHaveLength(BUILTIN_SENSE_TOOLS.length)
  })
})
