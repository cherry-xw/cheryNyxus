import { describe, expect, it } from 'vitest'
import { contextContentItemFromResponse } from '../../src/features/agent/workbench/context-analytics/contentModel'

describe('context content presentation model', () => {
  it('turns escaped tool descriptions into readable text and exposes parameter details', () => {
    const item = contextContentItemFromResponse(
      {
        id: 'tool-1',
        kind: 'tool',
        name: 'read_file',
        content: JSON.stringify({
          description: '读取文件\\n\\n只读操作',
          parameters: {
            type: 'object',
            required: ['path'],
            properties: {
              path: { type: 'string', description: '文件路径\\n可以是绝对路径' },
              limit: { type: ['number', 'null'], description: '最大行数' },
            },
          },
        }),
      },
      '冻结快照',
      'available',
    )

    expect(item.preview).toBe('读取文件\n\n只读操作')
    expect(item.toolParameters).toEqual([
      expect.objectContaining({ name: 'path', type: 'string', required: true, description: '文件路径\n可以是绝对路径' }),
      expect.objectContaining({ name: 'limit', type: 'number | null', required: false }),
    ])
    expect(item.content).toContain('\n  "description"')
  })
})
