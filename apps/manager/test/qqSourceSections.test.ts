import { describe, expect, it } from 'vitest'
import type { SourceContextItem } from '../../../packages/protocol/src/sourceManagement'
import { groupSourceSections } from '../../../plugins/qq/ui/sourceSections'

const item = (type: SourceContextItem['type'], itemId: string) => ({ type, itemId, text: '相同文字' })

describe('QQ source module grouping without a browser', () => {
  it('does not manufacture empty modules', () => {
    expect(groupSourceSections([])).toEqual([])
  })

  it('puts adjacent messages in one module without merging their identities or bodies', () => {
    const items = [item('message', 'first'), item('message', 'second')]
    const sections = groupSourceSections(items)
    expect(sections).toHaveLength(1)
    expect(sections[0]!.heading).toBe('输入消息')
    expect(sections[0]!.items).toEqual(items)
    expect(sections[0]!.items[0]).toBe(items[0])
    expect(sections[0]!.items[1]).toBe(items[1])
  })

  it('keeps separated messages in separate modules rather than regrouping by type', () => {
    const items = [item('message', 'first'), item('gap', 'range'), item('message', 'second')]
    const sections = groupSourceSections(items)
    expect(sections.map(section => section.type)).toEqual(['message', 'gap', 'message'])
    expect(sections.flatMap(section => section.items)).toEqual(items)
    expect(new Set(sections.map(section => section.key)).size).toBe(3)
  })

  it('names every supported content type without exposing restricted source information', () => {
    const items = ['message', 'gap', 'summary', 'data', 'tool_result', 'restricted'].map((type, i) =>
      item(type as SourceContextItem['type'], String(i)))
    expect(groupSourceSections(items).map(section => section.heading)).toEqual([
      '输入消息', '范围与省略说明', '已采用摘要', '附加资料', '本次工具过程', '内容受限',
    ])
  })

  it('never sorts or modifies the already selected input', () => {
    const items = Object.freeze([
      Object.freeze({ ...item('gap', 'later-id'), position: 9 }),
      Object.freeze({ ...item('message', 'earlier-id'), position: 1 }),
      Object.freeze({ ...item('message', 'another-id'), position: 4 }),
    ])
    const sections = groupSourceSections(items)
    expect(sections.flatMap(section => section.items)).toEqual(items)
    expect(items.map(entry => entry.position)).toEqual([9, 1, 4])
  })

  it('extends a continuous module across pages while keeping previous keys and results stable', () => {
    const first = [item('gap', 'range'), item('message', 'm1')]
    const before = groupSourceSections(first)
    const after = groupSourceSections([...first, item('message', 'm2'), item('summary', 's1')])
    expect(after.slice(0, 2).map(section => section.key)).toEqual(before.map(section => section.key))
    expect(after[1]!.items.map(entry => entry.itemId)).toEqual(['m1', 'm2'])
    expect(before[1]!.items.map(entry => entry.itemId)).toEqual(['m1'])
    expect(after[2]!.heading).toBe('已采用摘要')
  })

  it('preserves every item ID when a located page fills a gap between loaded messages', () => {
    const first = item('message', 'm1'), last = item('message', 'm9')
    expect(groupSourceSections([first, last])).toHaveLength(1)
    const ordered = [first, item('data', 'd2'), item('restricted', 'r3'), last]
    const sections = groupSourceSections(ordered)
    expect(sections).toHaveLength(4)
    expect(sections.flatMap(section => section.items.map(entry => entry.itemId))).toEqual(['m1', 'd2', 'r3', 'm9'])
    expect(sections.at(-1)!.items[0]).toBe(last)
  })
})
