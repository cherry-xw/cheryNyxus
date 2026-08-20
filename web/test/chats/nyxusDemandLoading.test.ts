import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('Nyxus demand loading contract', () => {
  it('keeps startup catalog-only instead of hydrating every running root', async () => {
    const source = await readFile(resolve('web/src/stores/chats/index.ts'), 'utf8')
    const startup = source.slice(source.indexOf('async function startup()'), source.indexOf('async function reconnect()'))

    expect(startup).toContain("agentApi.listChats({ scope: 'stage' })")
    expect(startup).not.toContain('hydrateTree(')
    expect(startup).not.toContain("scope: 'history'")
  })

  it('switches only the selected root tree and never aborts or replays chat.sync', async () => {
    const source = await readFile(
      resolve('web/src/features/agent/chat/AgentDialog.vue'),
      'utf8',
    )
    const switchSession = source.slice(
      source.indexOf('async function switchSession'),
      source.indexOf('/** 钢琴键「新建会话」'),
    )

    expect(switchSession).toContain("observeRootTimeline(id, 'tree')")
    expect(switchSession).not.toContain('hydrateTree(')
    expect(switchSession).not.toContain('abortAgent(')
  })

  it('does not scan all conversation previews when the Nyxus workspace opens', async () => {
    const core = await readFile(
      resolve('web/src/features/pets/nyxus/components/NyxusCore.vue'),
      'utf8',
    )
    const dialog = await readFile(
      resolve('web/src/features/agent/chat/AgentDialog.vue'),
      'utf8',
    )

    expect(core).not.toContain('fetchHistoryList()')
    expect(dialog).not.toContain('fetchHistoryList()')
  })

  it('does not preload histories during legacy Pet startup', async () => {
    const source = await readFile(resolve('web/src/stores/agents/index.ts'), 'utf8')
    const startup = source.slice(
      source.indexOf('async function initFromChats()'),
      source.indexOf('async function attachRunningChats'),
    )

    expect(startup).not.toContain('getHistory(')
    expect(startup).not.toContain('preloadTargets')
    expect(source).toContain('selectRefreshRecoveryChats(')
  })

  it('moves the first draft into the root queue before runtime RPC work begins', async () => {
    const source = await readFile(
      resolve('web/src/features/agent/dialog/useAgentDialogOptions.ts'),
      'utf8',
    )
    const send = source.slice(
      source.indexOf('async function handleSend'),
      source.indexOf('function onEditorKeydown'),
    )

    expect(send.indexOf('chatSessions.prepareInput')).toBeGreaterThan(-1)
    expect(send.indexOf('chatSessions.prepareInput')).toBeLessThan(
      send.indexOf('agents.setSessionRuntime'),
    )
    expect(send).toContain('chatSessions.observeRootTimeline')
    expect(send).not.toContain('chatSessions.openSession(targetChatId),')
  })

  it('keeps protocol subscription ownership out of the tree renderer', async () => {
    const source = await readFile(
      resolve('web/src/features/pets/nyxus/components/MessageBranchTree.vue'),
      'utf8',
    )

    expect(source).not.toContain('observeRootTimeline(')
    expect(source).not.toContain('openRootTimeline(')
    expect(source).not.toContain('subscriptionId')
  })

  it('does not reopen a root after its timeline patch has entered the message reducer', async () => {
    const source = await readFile(resolve('web/src/stores/chats/index.ts'), 'utf8')
    const applyEvent = source.slice(
      source.indexOf('function applyEvent('),
      source.indexOf('// ---- hydration 内核'),
    )

    expect(applyEvent).not.toContain('root timeline refresh')
    expect(applyEvent).not.toContain('observeRootTimeline(')
    expect(applyEvent).not.toContain('ensureRootSubscription(')
  })
})
