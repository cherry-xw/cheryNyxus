import { describe, expect, it, vi } from 'vitest'
import { createEmptySession } from '../src/stores/chats/hydration'
import { beginLiveRun, shouldResumeRoleReply } from '../src/stores/chats'

describe('chat live run recovery', () => {
  it('marks the canonical session working before a live resume receives stream output', () => {
    const session = createEmptySession('parent-chat')
    session.run.status = 'paused'
    session.run.error = 'waiting for answer'
    session.run.retainUntil = Date.now() + 10_000
    const onWorkingChange = vi.fn()

    expect(beginLiveRun(session, onWorkingChange)).toBe(true)
    expect(session.run).toMatchObject({
      status: 'running',
      error: undefined,
      retainUntil: undefined,
    })
    expect(session.ui.bubbleVisible).toBe(true)
    expect(onWorkingChange).toHaveBeenCalledWith('parent-chat', true)
  })

  it('does not restart an already-running session or replayed role reply', () => {
    const session = createEmptySession('parent-chat')
    session.run.status = 'running'
    const onWorkingChange = vi.fn()

    expect(beginLiveRun(session, onWorkingChange)).toBe(false)
    expect(onWorkingChange).not.toHaveBeenCalled()

    session.sync.replaying = true
    expect(shouldResumeRoleReply(session)).toBe(false)
  })
})
