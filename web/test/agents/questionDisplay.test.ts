import { describe, expect, it } from 'vitest'
import {
  parseQuestionAnswer,
  parseQuestionArgs,
} from '../../src/features/agent/renderers/core/questionDisplay'

describe('question history display', () => {
  const args = parseQuestionArgs(
    JSON.stringify({
      question: '选择需要保留的内容',
      header: '展示偏好',
      options: [
        { label: '文件, 路径', description: '保留完整路径' },
        { label: '执行结果', description: '保留工具输出' },
      ],
      multiSelect: true,
    }),
  )

  it('parses the question type and option descriptions', () => {
    expect(args).toEqual({
      question: '选择需要保留的内容',
      header: '展示偏好',
      options: [
        { label: '文件, 路径', description: '保留完整路径' },
        { label: '执行结果', description: '保留工具输出' },
      ],
      multiSelect: true,
    })
  })

  it('keeps selected labels and an other answer as separate display data', () => {
    expect(
      parseQuestionAnswer(
        '用户回答: 文件, 路径, 执行结果, 其他: 还要保留\n原始换行',
        'done',
        args,
      ),
    ).toEqual({
      kind: 'answered',
      labels: ['文件, 路径', '执行结果'],
      freeText: '还要保留\n原始换行',
    })
  })

  it('supports an answer containing only free text', () => {
    expect(parseQuestionAnswer('用户回答: 其他: 自定义回答', 'done', args)).toEqual({
      kind: 'answered',
      labels: [],
      freeText: '自定义回答',
    })
  })

  it('distinguishes waiting, cancellation, and missing historical answers', () => {
    expect(parseQuestionAnswer('', 'running', args).kind).toBe('running')
    expect(parseQuestionAnswer('(用户取消了此问题)', 'done', args).kind).toBe('cancelled')
    expect(parseQuestionAnswer('', 'done', args).kind).toBe('missing')
  })
})
