import { describe, expect, it } from 'vitest'
import {
  acceptedRouteCandidates,
  automaticRouteCandidate,
  canRequestAutomaticRoute,
  conversationTargetVisualState,
  nextTargetCycleState,
} from '../../src/features/agent/dialog/conversationTargetRouting'

describe('conversation target routing thresholds', () => {
  const candidates = [
    { chatId: 'low', confidence: 0.74 },
    { chatId: 'recommend', confidence: 0.84 },
    { chatId: 'automatic', confidence: 0.85 },
    { chatId: null, confidence: 0.99 },
  ]

  it('keeps recommendations separate from automatic selection', () => {
    expect(acceptedRouteCandidates(candidates).map((candidate) => candidate.chatId)).toEqual([
      'recommend',
      'automatic',
    ])
  })

  it('automatically selects only a valid high-confidence conversation', () => {
    expect(automaticRouteCandidate(candidates)?.chatId).toBe('automatic')
    expect(automaticRouteCandidate(candidates.slice(0, 2))).toBeUndefined()
  })

  it('runs routing only while the explicit AI option is active', () => {
    expect(canRequestAutomaticRoute(true, true, '继续这个任务')).toBe(true)
    expect(canRequestAutomaticRoute(false, true, '继续这个任务')).toBe(false)
    expect(canRequestAutomaticRoute(true, false, '继续这个任务')).toBe(false)
    expect(canRequestAutomaticRoute(true, true, ' ')).toBe(false)
  })

  it('keeps manual selection, AI recommendation, and idle sessions visually distinct', () => {
    expect(conversationTargetVisualState('manual', 'manual', 'user', ['recommended'])).toBe(
      'manual',
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
})
