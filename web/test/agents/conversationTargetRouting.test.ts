import { describe, expect, it } from 'vitest'
import {
  conversationTargetVisualState,
  nextTargetCycleState,
  visibleConversationTargetSessions,
} from '../../src/features/agent/composer/conversationTargetRouting'

describe('conversation target routing', () => {
  it('keeps manual selection, AI selection, recommendation, and idle sessions visually distinct', () => {
    expect(conversationTargetVisualState('manual', 'manual', 'user', ['recommended'])).toBe(
      'manual',
    )
    expect(conversationTargetVisualState('automatic', 'automatic', 'ai', ['automatic'])).toBe(
      'ai-selected',
    )
    expect(conversationTargetVisualState('recommended', undefined, undefined, ['recommended'])).toBe(
      'recommended',
    )
    expect(conversationTargetVisualState('idle', undefined, undefined, ['recommended'])).toBe('idle')
  })

  it('treats a manual half-selected session as recommended (half) visual state', () => {
    expect(conversationTargetVisualState('half', undefined, undefined, [], 'half')).toBe(
      'recommended',
    )
    expect(conversationTargetVisualState('other', undefined, undefined, [], 'half')).toBe('idle')
  })

  it('cycles a single click one notch: idle → half → full → idle', () => {
    expect(nextTargetCycleState('idle')).toBe('half')
    expect(nextTargetCycleState('half')).toBe('full')
    expect(nextTargetCycleState('full')).toBe('idle')
  })

  it('appends an off-screen selected conversation after the visible history', () => {
    const sessions = [
      { chatId: 'first', lastUserActivityAt: 50 },
      { chatId: 'second', lastUserActivityAt: 40 },
      { chatId: 'third', lastUserActivityAt: 30 },
      { chatId: 'selected', lastUserActivityAt: 20 },
      { chatId: 'last', lastUserActivityAt: 10 },
    ]

    expect(visibleConversationTargetSessions(sessions, 'selected').map(({ chatId }) => chatId)).toEqual([
      'first',
      'second',
      'third',
      'selected',
    ])
  })

  it('does not duplicate a selected conversation already visible or append the new control', () => {
    const sessions = [
      { chatId: 'first', createdAt: 30 },
      { chatId: 'second', createdAt: 20 },
      { chatId: 'third', createdAt: 10 },
    ]

    expect(visibleConversationTargetSessions(sessions, 'second')).toEqual(sessions)
    expect(visibleConversationTargetSessions(sessions, 'new')).toEqual(sessions)
  })
})
