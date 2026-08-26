import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

describe('Nyxus demand loading contract', () => {
  it('restores only running direct sessions from an atomic open snapshot', async () => {
    const source = await readComponentSource(resolve('web/src/stores/chats/index.ts'), 'utf8')
    const startup = source.slice(
      source.indexOf('async function startup()'),
      source.indexOf('async function reconnect()'),
    )

    expect(startup).toContain('refreshCatalog()')
    expect(startup).toContain('.filter((summary) => summary.running)')
    expect(startup).toContain('openSession(summary.chatId)')
    expect(startup).not.toContain('hydrateTree(')
    expect(startup).not.toContain('attachChat(')
    expect(startup).not.toContain('syncChat(')
  })

  it('keeps selected-root observation in the Workbench controller', async () => {
    const source = await readComponentSource(
      resolve('web/src/features/agent/workbench/useWorkbenchTreeSession.ts'),
      'utf8',
    )

    expect(source).toContain("acquireRootTimeline(rootChatId, rootSubscriptionOwner, 'tree')")
    expect(source).not.toContain('hydrateTree(')
    expect(source).not.toContain('abortAgent(')
    expect(source).not.toContain('chat.sync')
  })

  it('does not scan conversation previews when the Nyxus workspace opens', async () => {
    const core = await readComponentSource(
      resolve('web/src/features/pets/nyxus/components/NyxusCore.vue'),
      'utf8',
    )
    const dialog = await readComponentSource(
      resolve('web/src/features/agent/chat/AgentDialog.vue'),
      'utf8',
    )

    expect(core).not.toContain('fetchHistoryList()')
    expect(dialog.indexOf('fetchHistoryList()')).toBeGreaterThan(
      dialog.indexOf('targetChatId = await agents.createMasterPet'),
    )
  })

  it('keeps transport ownership out of the agents compatibility facade', async () => {
    const source = await readComponentSource(resolve('web/src/stores/agents/index.ts'), 'utf8')
    const startup = source.slice(source.indexOf('async function initFromChats()'))

    expect(startup).not.toContain('getHistory(')
    expect(startup).not.toContain('preloadTargets')
    expect(source).not.toContain('agentApi.openChat(')
    expect(source).not.toContain('bindWsClient(')
  })

  it('queues the first draft before runtime RPC and root observation', async () => {
    const source = await readComponentSource(
      resolve('web/src/features/agent/composer/useAgentDialogOptions.ts'),
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
    expect(send).toContain('chatSessions.acquireRootTimeline')
    expect(send.indexOf('chatSessions.acquireRootTimeline')).toBeGreaterThan(
      send.indexOf('agents.setSessionRuntime'),
    )
    expect(send).toContain('chatSessions.releaseRootTimeline')
  })

  it('keeps protocol subscription ownership out of the tree renderer', async () => {
    const source = await readComponentSource(
      resolve('web/src/features/pets/nyxus/components/MessageBranchTree.vue'),
      'utf8',
    )

    expect(source).not.toContain('observeRootTimeline(')
    expect(source).not.toContain('openRootTimeline(')
    expect(source).not.toContain('subscriptionId')
  })

  it('does not reopen a root after its timeline patch enters the message reducer', async () => {
    const source = await readComponentSource(resolve('web/src/stores/chats/index.ts'), 'utf8')
    const applyEvent = source.slice(
      source.indexOf('function applyEvent('),
      source.indexOf('// ---- hydration'),
    )

    expect(applyEvent).not.toContain('root timeline refresh')
    expect(applyEvent).not.toContain('observeRootTimeline(')
    expect(applyEvent).not.toContain('ensureRootSubscription(')
  })
})
