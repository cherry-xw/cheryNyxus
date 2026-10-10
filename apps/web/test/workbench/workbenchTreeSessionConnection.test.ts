import { effectScope, nextTick, reactive, ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type MockAgentsStore = {
  workbenchWindows: Record<string, { interactionFocus?: unknown }>
  historyList: Array<{ taskId?: string }>
  latestRootInPreset: ReturnType<typeof vi.fn>
  setWorkbenchWindowChat: ReturnType<typeof vi.fn>
}

type MockChatSessionsStore = {
  acquireRootTimeline: ReturnType<typeof vi.fn>
  releaseRootTimeline: ReturnType<typeof vi.fn>
  ensureQuestionHydrated: ReturnType<typeof vi.fn>
  rootTimeline: ReturnType<typeof vi.fn>
}

const mocks = vi.hoisted(() => ({
  agents: undefined as MockAgentsStore | undefined,
  chats: undefined as MockChatSessionsStore | undefined,
  connection: undefined as { status: string } | undefined,
}))

vi.mock('@/application/public', () => ({
  useAgentsStore: () => mocks.agents,
  useChatSessionsStore: () => mocks.chats,
  useConnectionStore: () => mocks.connection,
}))

vi.mock('@/application/backend/public', () => ({
  agentApi: { getTaskTimeline: vi.fn() },
}))

import { useWorkbenchTreeSession } from '../../src/features/agent/workbench/useWorkbenchTreeSession'

describe('workbench tree session connection timing', () => {
  beforeEach(() => {
    mocks.agents = {
      workbenchWindows: { preset: {} },
      historyList: [],
      latestRootInPreset: vi.fn(),
      setWorkbenchWindowChat: vi.fn(),
    }
    mocks.chats = {
      acquireRootTimeline: vi.fn().mockResolvedValue(undefined),
      releaseRootTimeline: vi.fn().mockResolvedValue(undefined),
      ensureQuestionHydrated: vi.fn().mockResolvedValue(undefined),
      rootTimeline: vi.fn().mockReturnValue(undefined),
    }
    mocks.connection = reactive({ status: 'disconnected' })
  })

  it('waits for the WebSocket before observing a session restored on refresh', async () => {
    const scope = effectScope()
    const taskTimeline = ref(undefined)
    scope.run(() =>
      useWorkbenchTreeSession({
        windowId: 'preset',
        presetId: 'preset',
        presetName: 'assistant',
        isNyxus: false,
        chatId: () => 'restored-root',
        taskTimeline,
        resetComposerBranch: vi.fn(),
        resetDraft: vi.fn(),
        setError: vi.fn(),
      }),
    )

    await nextTick()
    expect(mocks.chats!.acquireRootTimeline).not.toHaveBeenCalled()

    mocks.connection!.status = 'connected'
    await nextTick()
    await Promise.resolve()

    expect(mocks.chats!.acquireRootTimeline).toHaveBeenCalledWith(
      'restored-root',
      'workbench:preset',
      'tree',
    )
    expect(mocks.chats!.ensureQuestionHydrated).toHaveBeenCalledWith('restored-root')
    scope.stop()
  })
})
