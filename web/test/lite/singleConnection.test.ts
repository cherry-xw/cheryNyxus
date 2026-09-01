import { readComponentSource } from '../helpers/componentSource'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import {
  agentApi,
  type TimelineNode,
  type TimelineNodeDetailResponse,
} from '../../src/services/agentApi'
import { wsClient } from '../../src/services/ws'
import { useLiteViewToggle } from '../../src/features/agent/workbench/useLiteViewToggle'
import { useLiteStore } from '../../src/features/lite/liteStore'
import { useLiteCanonicalView } from '../../src/features/lite/useLiteCanonicalView'
import { useChatSessionsStore } from '../../src/stores/chats'
import { useConnectionStore } from '../../src/stores/connection'

describe('workbench Lite single-connection integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    })
  })

  it('toggles presentation without touching the socket, root subscription or running task', () => {
    const connect = vi.spyOn(wsClient, 'connect')
    const disconnect = vi.spyOn(wsClient, 'disconnect')
    const open = vi.spyOn(agentApi, 'openChat')
    const close = vi.spyOn(agentApi, 'closeChat')
    const chats = useChatSessionsStore()
    const session = chats.ensureEntity('root-live')
    session.run.status = 'running'
    session.run.activeRunId = 'run-live'
    chats.rootSubscriptions['root-live'] = {
      subscriptionId: 'subscription-live',
      eventSeq: 7120,
    }
    const before = { ...chats.rootSubscriptions['root-live'] }

    const { liteViewEnabled, toggleLiteView } = useLiteViewToggle('window-a')
    toggleLiteView()
    expect(liteViewEnabled.value).toBe(true)
    toggleLiteView()
    expect(liteViewEnabled.value).toBe(false)

    expect(connect).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expect(chats.rootSubscriptions['root-live']).toEqual(before)
    expect(chats.sessionsById['root-live']?.run).toMatchObject({
      status: 'running',
      activeRunId: 'run-live',
    })
  })

  it('isolates drafts, expansion, scroll and errors by window plus explicit root', () => {
    const lite = useLiteStore()
    lite.setActive('window-a', true)
    lite.patchRootUi('window-a', 'root-one', {
      inputDraft: 'draft one',
      expandedItemIds: ['subtasks'],
      scrollTop: 240,
      commandError: { code: 'RATE_LIMITED', message: 'later' },
    })
    lite.patchRootUi('window-a', 'root-two', { inputDraft: 'draft two' })
    lite.patchRootUi('window-b', 'root-one', { inputDraft: 'other window' })

    expect(lite.rootUi('window-a', 'root-one')).toMatchObject({
      inputDraft: 'draft one',
      expandedItemIds: ['subtasks'],
      scrollTop: 240,
    })
    expect(lite.rootUi('window-a', 'root-two')).toMatchObject({
      inputDraft: 'draft two',
      expandedItemIds: [],
      scrollTop: 0,
      commandError: null,
    })
    expect(lite.rootUi('window-b', 'root-one')?.inputDraft).toBe('other window')

    lite.clearWindow('window-a')
    expect(lite.rootUi('window-a', 'root-one')).toBeUndefined()
    expect(lite.rootUi('window-a', 'root-two')).toBeUndefined()
    expect(lite.rootUi('window-b', 'root-one')?.inputDraft).toBe('other window')
    expect(lite.isLiteActive('window-a')).toBe(true)
  })

  it('routes Lite input through the canonical chat command path', async () => {
    const chats = useChatSessionsStore()
    const prepared = {
      chatId: 'root-live',
      content: 'hello',
      clientMessageId: 'client-message',
      commandId: 'command-live',
      messageId: 'message-live',
      provisionalInputId: 'optimistic-input:client-message',
      startedRun: true,
    }
    const prepare = vi.spyOn(chats, 'prepareInput').mockReturnValue(prepared)
    const submit = vi.spyOn(chats, 'submitInput').mockResolvedValue({
      inputId: 'input-live',
      clientMessageId: 'client-message',
      messageId: 'message-live',
      content: 'hello',
      state: 'accepted',
    })
    const lite = useLiteCanonicalView(
      () => 'window-a',
      () => 'root-live',
    )

    await expect(lite.submitInput('hello')).resolves.toBe(true)
    expect(prepare).toHaveBeenCalledWith('root-live', 'hello')
    expect(submit).toHaveBeenCalledWith('root-live', 'hello', undefined, prepared)
  })

  it('maps a canonical socket interruption without an error to reconnecting', () => {
    const connect = vi.spyOn(wsClient, 'connect')
    const disconnect = vi.spyOn(wsClient, 'disconnect')
    const connection = useConnectionStore()
    connection.status = 'disconnected'
    connection.error = null

    const active = useLiteCanonicalView(
      () => 'window-a',
      () => 'root-live',
    )
    const empty = useLiteCanonicalView(
      () => 'window-empty',
      () => '',
    )

    expect(active.connection.phase).toBe('reconnecting')
    expect(empty.connection.phase).toBe('idle')
    expect(connect).not.toHaveBeenCalled()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('uses the complete canonical node-detail response contract', () => {
    expectTypeOf<TimelineNodeDetailResponse>().toEqualTypeOf<{
      rootChatId: string
      node: TimelineNode
      refs: Array<{ field: string; contentLength: number; contentHash: string }>
      hasMore: boolean
    }>()
  })

  it('uses one persisted toggle entry for the browser and Electron workbench entries', () => {
    const browser = useLiteViewToggle('preset-a')
    const electron = useLiteViewToggle('preset-a')

    browser.toggleLiteView()
    expect(browser.liteViewEnabled.value).toBe(true)
    expect(electron.liteViewEnabled.value).toBe(true)
    expect(localStorage.getItem('cherynyxus:workbench-lite-view:preset-a')).toBe('1')

    electron.toggleLiteView()
    expect(browser.liteViewEnabled.value).toBe(false)
    expect(electron.liteViewEnabled.value).toBe(false)
  })

  it('keeps Lite integration free of a private client, hydration and root guessing', async () => {
    const [store, adapter, toggle, workbench, viewToggle] = await Promise.all([
      readComponentSource(resolve('src/features/lite/liteStore.ts'), 'utf8'),
      readComponentSource(resolve('src/features/lite/useLiteCanonicalView.ts'), 'utf8'),
      readComponentSource(resolve('src/features/agent/workbench/useLiteViewToggle.ts'), 'utf8'),
      readComponentSource(resolve('src/features/agent/workbench/WorkbenchDialog.vue'), 'utf8'),
      readComponentSource(resolve('src/features/agent/workbench/WorkbenchViewToggle.vue'), 'utf8'),
    ])
    const productionLite = `${store}\n${adapter}\n${toggle}`

    expect(productionLite).not.toContain('LiteClient')
    expect(productionLite).not.toContain("'chat.open'")
    expect(productionLite).not.toContain("'chat.close'")
    expect(toggle).not.toContain('.connect(')
    expect(toggle).not.toContain('.disconnect(')
    expect(adapter).toContain('chats.executionReadModel(root())')
    expect(adapter).toContain('chats.rootTimeline(root()')
    expect(adapter).not.toContain('chat.list')
    expect(workbench).toContain(':root-chat-id="treeRootChatId"')
    expect(workbench).toContain('<WorkbenchViewToggle :window-id="windowId" />')
    expect(viewToggle).toContain('@click="liteViewEnabled && toggleLiteView()"')
    expect(viewToggle).toContain('@click="!liteViewEnabled && toggleLiteView()"')
    expect(workbench).toContain(
      'const liteViewVisible = computed(() => liteViewEnabled.value && !!treeRootChatId.value)',
    )
  })
})
