import { afterEach, expect, it, vi } from 'vitest'
import { useTransientNotices } from '../../src/features/agent/settings/components/useTransientNotices'

const cleanup = vi.hoisted(() => [] as (() => void)[])
vi.mock('vue', async (original) => ({
  ...(await original<typeof import('vue')>()),
  onBeforeUnmount: (fn: () => void) => cleanup.push(fn),
}))
afterEach(() => {
  cleanup.splice(0).forEach((fn) => fn())
  vi.useRealTimers()
})

it('shows results temporarily and does not carry errors into a reopened session', () => {
  vi.useFakeTimers()
  const feedback = useTransientNotices()
  expect(feedback.notices.value).toEqual([])
  feedback.show([
    { id: 'saved', kind: 'message', text: '已保存' },
    { id: 'bad', kind: 'error', text: '失败' },
  ])
  vi.advanceTimersByTime(5000)
  expect(feedback.notices.value.map((notice) => notice.kind)).toEqual(['error'])
  vi.advanceTimersByTime(5000)
  expect(feedback.notices.value).toEqual([])
  feedback.show([{ id: 'bad', kind: 'error', text: '失败' }])
  expect(feedback.notices.value).toHaveLength(1)
  cleanup.splice(0).forEach((fn) => fn())
  expect(vi.getTimerCount()).toBe(0)
  expect(useTransientNotices().notices.value).toEqual([])
})

it('keeps details available while hovered, focused, or open', () => {
  vi.useFakeTimers()
  const feedback = useTransientNotices()
  feedback.show([{ id: 'warn', kind: 'warning', text: '警告' }])
  feedback.pause('hover')
  feedback.pause('warning')
  feedback.resume('hover')
  vi.advanceTimersByTime(20000)
  expect(feedback.notices.value).toHaveLength(1)
  feedback.resume('warning')
  vi.advanceTimersByTime(10000)
  expect(feedback.notices.value).toEqual([])
})
