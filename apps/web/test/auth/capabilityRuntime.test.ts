import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, reactive, shallowRef } from 'vue'
const state = vi.hoisted(() => ({ status: undefined as undefined | ((s: string) => void), notify: undefined as undefined | ((v: unknown) => void), enabled: new Set<string>() }))
const workspace = reactive({ settingsOpen: false, workspaceWindows: {} as Record<string, unknown>, workspaceWindowsList: [], workbenchWindowsList: [], activeDialogChatId: null, activeNyxusChatId: null, activeRootByPreset: {}, setWorkspaceWindowAttention: vi.fn(), closeAllHistory: vi.fn(), closeWorkbenchWindow: vi.fn(), removeWorkspaceWindow: vi.fn() })
const auth = reactive({ locked: false })
const bootstrap = shallowRef<{ instanceId: string; revision: string }>()
const config = { refresh: vi.fn(async () => {}), apply: vi.fn(() => false), resetTarget: vi.fn() }
const overview = { pendingCount: 0, reopen: vi.fn(async () => {}), close: vi.fn(async () => {}), applyChanged: vi.fn(), resetTarget: vi.fn() }
const chats = { sessionsById: {}, bindWsClient: vi.fn(), bindEffects: vi.fn(), unbindWsClient: vi.fn(), startup: vi.fn(async () => {}), reconnect: vi.fn(async () => {}), refreshCatalog: vi.fn(async () => {}), evictSessions: vi.fn(async () => {}), resetTarget: vi.fn() }
const agents = { setWorkingForChat: vi.fn(), removePetsOnly: vi.fn(), bindSessionEvictor: vi.fn(), reconcilePetsFromSessions: vi.fn(), initFromChats: vi.fn(async () => {}), refreshPresentationConfig: vi.fn(async () => {}), resetTarget: vi.fn() }
const interactions = { refresh: vi.fn(async () => {}), upsert: vi.fn(), resetTarget: vi.fn() }
const commands = { connectionChanged: vi.fn(), poll: vi.fn(), apply: vi.fn(), resetTarget: vi.fn() }
vi.mock('@/stores/agentCommands', () => ({ useAgentCommandsStore: () => commands }))
vi.mock('@/services/agentApiTransport', () => ({ clearServerConfigCache: vi.fn() }))
vi.mock('@/stores/auth', () => ({ useAuthStore: () => auth }))
vi.mock('@/stores', () => ({ useConnectionStore: () => ({ status: 'connected', init: vi.fn() }), useConfigApplyStore: () => config, useAgentsStore: () => agents, useChatSessionsStore: () => chats, useInteractionsStore: () => interactions, useTaskOverviewStore: () => overview, useWorkspaceStore: () => workspace }))
vi.mock('@/services/platform', () => ({ capabilityEnabled: (s: string) => state.enabled.has(s), currentCapabilities: () => bootstrap.value }))
vi.mock('@/services/ws', () => ({ wsClient: { getStatus: () => 'disconnected', onStatus: (fn: (s: string) => void) => { state.status = fn; return vi.fn() }, onNotification: (fn: (v: unknown) => void) => { state.notify = fn; return vi.fn() } } }))
vi.mock('../../src/application/archiveChanges', () => ({ invalidateArchives: vi.fn() }))
import { startApplicationRuntime } from '../../src/application/runtime/startApplicationRuntime'
describe('runtime capability request counts without browser UI', () => {
  beforeEach(() => { vi.clearAllMocks(); state.enabled.clear(); workspace.settingsOpen = false; workspace.workspaceWindows = {}; auth.locked = false; bootstrap.value = undefined })
  it('basic startup requests core state but zero optional configuration or overview subscriptions', async () => {
    const stop = startApplicationRuntime(); state.status!('connected'); await nextTick()
    expect(chats.startup).toHaveBeenCalledOnce(); expect(interactions.refresh).toHaveBeenCalledOnce()
    expect(config.refresh).not.toHaveBeenCalled(); expect(overview.reopen).not.toHaveBeenCalled()
    workspace.settingsOpen = true; workspace.workspaceWindows['window:task-center'] = {}; await nextTick()
    expect(config.refresh).not.toHaveBeenCalled(); expect(overview.reopen).not.toHaveBeenCalled()
    stop(); expect(chats.unbindWsClient).toHaveBeenCalledOnce()
  })
  it.each(['restart', 'downgrade', 'upgrade', 'revision'])('F05 %s clears all resource owners and restores core from new snapshot', async (kind) => {
    bootstrap.value = { instanceId: 'same', revision: 'before' }; state.enabled.add('settings.manage'); state.enabled.add('task.overview')
    const stop = startApplicationRuntime(); state.status!('connected'); await nextTick(); state.status!('disconnected')
    workspace.settingsOpen = true; workspace.activeDialogChatId = 'old' as never; workspace.activeNyxusChatId = 'old' as never; workspace.activeRootByPreset = { old: 'root' }
    vi.clearAllMocks(); if (kind === 'downgrade') state.enabled.clear()
    bootstrap.value = { instanceId: kind === 'restart' ? 'new-instance' : 'same', revision: 'after' }; await nextTick()
    for (const owner of [chats, agents, interactions, overview, config, commands]) expect(owner.resetTarget).toHaveBeenCalledOnce()
    expect(workspace.settingsOpen).toBe(false); expect(workspace.activeDialogChatId).toBeNull(); expect(workspace.activeNyxusChatId).toBeNull(); expect(workspace.activeRootByPreset).toEqual({}); expect(workspace.closeAllHistory).toHaveBeenCalledOnce()
    state.status!('connected'); await nextTick(); expect(chats.startup).toHaveBeenCalledOnce(); expect(chats.reconnect).not.toHaveBeenCalled(); expect(interactions.refresh).toHaveBeenCalledOnce(); expect(config.refresh).not.toHaveBeenCalled(); expect(overview.reopen).not.toHaveBeenCalled()
    stop(); expect(chats.unbindWsClient).toHaveBeenCalledOnce()
  })
  it('F05 unchanged instance/revision preserves resources on transient reconnect', async () => {
    bootstrap.value = { instanceId: 'same', revision: 'same' }; const stop = startApplicationRuntime(); state.status!('connected'); await nextTick(); vi.clearAllMocks(); state.status!('disconnected'); bootstrap.value = { instanceId: 'same', revision: 'same' }; state.status!('connected'); await nextTick()
    for (const owner of [chats, agents, interactions, overview, config, commands]) expect(owner.resetTarget).not.toHaveBeenCalled(); expect(chats.reconnect).toHaveBeenCalledOnce(); stop()
  })
  it('full startup defers optional requests until opened and resets every owner on identity lock', async () => {
    state.enabled.add('settings.manage'); state.enabled.add('task.overview')
    const stop = startApplicationRuntime(); state.status!('connected'); await nextTick()
    expect(config.refresh).not.toHaveBeenCalled(); expect(overview.reopen).not.toHaveBeenCalled()
    workspace.settingsOpen = true; await nextTick(); expect(config.refresh).toHaveBeenCalledOnce()
    workspace.workspaceWindows['window:task-center'] = {}; await nextTick(); expect(overview.reopen).toHaveBeenCalledOnce()
    auth.locked = true; await nextTick()
    for (const owner of [chats, agents, interactions, overview, config, commands]) expect(owner.resetTarget).toHaveBeenCalledOnce()
    stop()
  })
})
