import { describe, expect, it } from 'vitest'
import {
  interactionView,
  terminalActionMode,
} from '../../../src/features/pets/nyxus/composables/nodeInteraction'

const call = { id: 'q1', name: 'ask_user_question', status: 'running' as const }

describe('Nyxus node interaction state', () => {
  it('distinguishes unanswered and answered question nodes', () => {
    expect(
      interactionView(call, {
        question: {
          questionId: 'q1',
          position: 0,
          question: 'Continue?',
          options: [],
          multiSelect: false,
          createdAt: 1,
          localStatus: 'pending',
        },
      }),
    ).toMatchObject({ state: 'pending', badge: '待回答', interactive: true })

    expect(interactionView({ ...call, status: 'done', result: '用户回答: Yes' })).toMatchObject({
      state: 'answered',
      badge: '已回答',
      interactive: false,
    })
  })

  it('marks expired approvals as non-interactive', () => {
    expect(
      interactionView(call, {
        approval: {
          approvalId: 'q1',
          senseName: 'ask_user_question',
          waitTime: 1000,
          createdAt: 1,
        },
        expired: true,
      }),
    ).toMatchObject({ state: 'expired', badge: '已过期', interactive: false })
  })

  it('uses the same stop/resume guard for the terminal tree node', () => {
    expect(terminalActionMode(true, false, true)).toBe('stop')
    expect(terminalActionMode(false, true, false)).toBe('run')
    expect(terminalActionMode(false, true, true)).toBe('continue')
    expect(terminalActionMode(false, false, false)).toBe('continue')
  })
})
