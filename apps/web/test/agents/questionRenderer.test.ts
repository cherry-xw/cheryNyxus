import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'
import { findInteractiveQuestion } from '../../src/features/agent/renderers/core/questionDisplay'
import type { InteractionRecord } from '../../src/services/agentApi'
import {
  draftOf,
  toggleOption,
  toggleOther,
} from '../../src/features/agent/attention/useInteractionDrafts'

function batchRecord(
  interactionId: string,
  overrides: Partial<InteractionRecord> = {},
): InteractionRecord {
  return {
    interactionId,
    kind: 'question_batch',
    chatId: 'c1',
    rootChatId: 'c1',
    status: 'pending',
    payload: {
      questions: [
        {
          questionId: 'call_q1',
          question: '选择方案',
          options: [{ label: 'A' }, { label: 'B' }],
          multiSelect: false,
        },
        {
          questionId: 'call_q2',
          question: '补充说明',
          options: [{ label: 'X' }],
          multiSelect: true,
        },
      ],
    },
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

describe('findInteractiveQuestion', () => {
  it('matches the running sense call to its pending question batch item by call.id = questionId', () => {
    const match = findInteractiveQuestion('call_q2', [batchRecord('b1')])
    expect(match?.item.interactionId).toBe('b1')
    expect(match?.question.questionId).toBe('call_q2')
  })

  it('returns null when the call id is missing or unknown', () => {
    expect(findInteractiveQuestion(undefined, [batchRecord('b1')])).toBeNull()
    expect(findInteractiveQuestion('call_q9', [batchRecord('b1')])).toBeNull()
  })

  it('returns null for resolved or non-question interactions', () => {
    const resolved = batchRecord('b1', { status: 'completed' })
    expect(findInteractiveQuestion('call_q1', [resolved])).toBeNull()

    const approval: InteractionRecord = {
      interactionId: 'a1',
      kind: 'approval',
      chatId: 'c1',
      rootChatId: 'c1',
      status: 'pending',
      payload: {},
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    }
    expect(findInteractiveQuestion('call_q1', [approval])).toBeNull()
  })
})

describe('question renderer in-list answering contract', () => {
  it('renders clickable options and submits via interactions.answer while pending', async () => {
    const source = await readComponentSource(
      resolve('web/src/features/agent/renderers/core/QuestionRenderer.vue'),
      'utf8',
    )
    const display = await readComponentSource(
      resolve('web/src/features/agent/renderers/core/questionDisplay.ts'),
      'utf8',
    )

    // 可交互匹配：call.status running + pending 提问批按 call.id 命中
    expect(display).toContain('findInteractiveQuestion')
    expect(display).toContain("item.status !== 'pending'")
    expect(source).toContain('findInteractiveQuestion(props.call.id, interactions.pending)')

    // 列表内直接作答：可点选项 + 补充 + 提交
    expect(source).toContain('class="q-option is-btn"')
    expect(source).toContain('toggleOption(')
    expect(source).toContain('class="q-submit"')
    expect(source).toContain('interactions.answer(item, answers)')

    // 「其他」也作为选项项（与单选/多选视觉一致），点击展开自由文本输入
    expect(source).toContain('is-other')
    expect(source).toContain('toggleOther(interactive.item, interactive.question.questionId)')
    expect(source).toContain('otherOpenOf(interactive.item, interactive.question.questionId)')
    expect(source).toContain('填写自己的回答')

    // 批内多题：全部作答后提交（草稿全局共享，逐卡作答后任一卡片可提交整批）
    expect(source).toContain('questionAnswered(item, question)')
    expect(source).toContain('本批共')

    // 只读展示保留（已答/已取消/数据未命中）
    expect(source).toContain('isSelected(opt.label)')
    expect(source).toContain('q-other-answer')
  })
})

describe('question draft other-option mutual exclusion', () => {
  const item = batchRecord('b1')

  it('opens the other option and clears selected labels on single choice', () => {
    const qid = 'call_q1'
    toggleOption(item, qid, 'A', false)
    toggleOther(item, qid)
    const draft = draftOf(item, qid)
    expect(draft.otherOpen).toBe(true)
    expect(draft.selectedLabels).toEqual([])
  })

  it('closing the other option clears the free text', () => {
    const qid = 'call_q1'
    const draft = draftOf(item, qid)
    draft.otherOpen = true
    draft.freeText = '自定义'
    toggleOther(item, qid)
    expect(draft.otherOpen).toBe(false)
    expect(draft.freeText).toBe('')
  })

  it('selecting a real option on single choice gives up the other option', () => {
    const qid = 'call_q1'
    const draft = draftOf(item, qid)
    draft.otherOpen = true
    draft.freeText = '自定义'
    toggleOption(item, qid, 'A', false)
    expect(draft.selectedLabels).toEqual(['A'])
    expect(draft.otherOpen).toBe(false)
    expect(draft.freeText).toBe('')
  })

  it('keeps other options selected alongside the other option on multi select', () => {
    const qid = 'call_q2'
    toggleOption(item, qid, 'X', true)
    toggleOther(item, qid)
    const draft = draftOf(item, qid)
    expect(draft.selectedLabels).toEqual(['X'])
    expect(draft.otherOpen).toBe(true)
  })
})
