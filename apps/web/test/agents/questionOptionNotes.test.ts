import { describe, expect, it } from 'vitest'
import type { InteractionRecord } from '../../src/services/agentApi'
import { validateInteractionAnswers } from '../../src/stores/interactions'

function questionBatch(payload: Record<string, unknown>): InteractionRecord {
  return {
    interactionId: 'batch-1',
    kind: 'question_batch',
    chatId: 'root',
    rootChatId: 'root',
    status: 'pending',
    payload,
    revision: 1,
    createdAt: 10,
    updatedAt: 10,
  }
}

function single(options: string[]): Record<string, unknown> {
  return {
    questions: [
      {
        questionId: 'q1',
        question: '请选择',
        options: options.map((label) => ({ label })),
        multiSelect: false,
      },
    ],
  }
}

describe('validateInteractionAnswers：每选项补充描述（optionNotes）', () => {
  it('单选：已选选项 + note 通过校验（note 不影响必选判定）', () => {
    const item = questionBatch(single(['是', '否']))
    const errors = validateInteractionAnswers(item, [
      { questionId: 'q1', selectedLabels: ['是'], optionNotes: { 是: '因为……' } },
    ])
    expect(errors).toEqual({})
  })

  it('多选：多个已选选项各自带 note 通过校验', () => {
    const item = questionBatch({
      questions: [
        {
          questionId: 'q1',
          question: '多选',
          options: [{ label: '甲' }, { label: '乙' }, { label: '丙' }],
          multiSelect: true,
        },
      ],
    })
    const errors = validateInteractionAnswers(item, [
      {
        questionId: 'q1',
        selectedLabels: ['甲', '乙'],
        optionNotes: { 甲: 'A 细节', 乙: 'B 细节' },
      },
    ])
    expect(errors).toEqual({})
  })

  it('note 不能替代未选选项：单选未选任何选项仍报 REQUIRED', () => {
    const item = questionBatch(single(['是', '否']))
    const errors = validateInteractionAnswers(item, [
      { questionId: 'q1', selectedLabels: [], optionNotes: { 是: '只有描述没选择' } },
    ])
    expect(errors.q1?.code).toBe('REQUIRED')
  })

  it('向后兼容：旧答案（无 optionNotes）保持原校验行为', () => {
    const item = questionBatch(single(['是', '否']))
    expect(
      validateInteractionAnswers(item, [{ questionId: 'q1', selectedLabels: ['否'] }]),
    ).toEqual({})
    expect(
      validateInteractionAnswers(item, [{ questionId: 'q1', selectedLabels: [] }]).q1?.code,
    ).toBe('REQUIRED')
  })
})
