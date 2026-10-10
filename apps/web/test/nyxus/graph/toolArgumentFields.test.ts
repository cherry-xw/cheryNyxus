import { describe, expect, it } from 'vitest'
import {
  fieldLabel,
  fieldViews,
  flattenFieldViews,
} from '../../../src/features/pets/nyxus/graph/toolArgumentFields'

describe('semantic tool fields', () => {
  it('never collapses an unknown key to the generic label 参数', () => {
    expect(fieldLabel('customTargetId')).toBe('custom Target Id（customTargetId）')
    expect(fieldLabel('customTargetId')).not.toBe('参数')
  })

  it('recursively exposes arrays, objects, booleans and selected targets', () => {
    const fields = fieldViews({
      multiSelect: true,
      options: [
        { label: '目标甲', description: '首个目标' },
        { label: '目标乙', description: '第二个目标' },
      ],
      answer: { labels: ['目标乙'], freeText: '补充说明' },
    })
    const flat = flattenFieldViews(fields)

    expect(fields.map((field) => field.kind)).toEqual(['boolean', 'list', 'group'])
    expect(flat.map((field) => field.key)).toContain('options[1].label')
    expect(flat.find((field) => field.key === 'answer.labels[0]')?.value).toBe('目标乙')
    expect(flat.every((field) => field.label !== '参数')).toBe(true)
  })
})
