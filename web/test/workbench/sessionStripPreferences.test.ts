import { describe, expect, it } from 'vitest'
import { parseSessionStripPreference } from '@/features/agent/workbench/useSessionStripPreferences'

describe('parseSessionStripPreference', () => {
  it('rejects malformed persisted data without throwing', () => {
    expect(parseSessionStripPreference(null)).toEqual({
      version: 1,
      slots: [],
      dismissedAttentionKeys: {},
    })
    expect(parseSessionStripPreference({ version: 1, slots: [{ taskKey: 'broken' }] }).slots).toEqual(
      [],
    )
  })

  it('keeps valid stable slots and string attention keys', () => {
    const snapshot = {
      taskKey: 'task-a',
      rootChatId: 'root-a',
      originalChatId: 'root-a',
      openChatId: 'open-a',
      relatedChatIds: ['branch-a'],
      title: '任务 A',
      status: 'running',
      unreadResult: false,
      attentionKey: 'run-1',
      pendingCount: 0,
      updatedAt: 10,
    }
    expect(
      parseSessionStripPreference({
        version: 1,
        slots: [{ taskKey: 'task-a', snapshot }],
        dismissedAttentionKeys: { 'task-b': 'result-2', broken: 3 },
      }),
    ).toEqual({
      version: 1,
      slots: [{ taskKey: 'task-a', snapshot }],
      dismissedAttentionKeys: { 'task-b': 'result-2' },
    })
  })
})
