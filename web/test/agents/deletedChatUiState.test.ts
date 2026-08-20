import { describe, expect, it } from 'vitest'
import { createUiState } from '../../src/stores/agents/ui/uiState'

describe('deleted chat UI pruning', () => {
  it('clears every chat reference while preserving workbench preferences', () => {
    const ui = createUiState()
    const windowId = ui.openWorkbenchWindow('preset-a')
    ui.activeDialogChatId.value = 'root'
    ui.activeNyxusChatId.value = 'root'
    ui.activeRootByPreset.value = { 'id:preset-a': 'root' }
    ui.setWorkbenchWindowChat(windowId, 'root')
    ui.setWorkbenchWindowView(windowId, 'tree')
    ui.setWorkbenchWindowGeometry(windowId, {
      mode: 'window',
      position: { x: 120, y: 80 },
      size: { width: 900, height: 700 },
    })
    ui.setWorkbenchWindowDrawer(windowId, {
      stack: ['root', 'child'],
      mode: 'workbench-docked',
      anchor: { x: 1, y: 2 },
    })
    ui.setWorkbenchWindowFocus(windowId, { sourceChatId: 'child' })

    ui.pruneDeletedChats(['root', 'child'])

    const window = ui.workbenchWindows.value[windowId]!
    expect(ui.activeDialogChatId.value).toBeNull()
    expect(ui.activeNyxusChatId.value).toBeNull()
    expect(ui.activeRootByPreset.value).toEqual({})
    expect(window.chatId).toBeNull()
    expect(window.historyDrawerStack).toEqual([])
    expect(window.interactionFocus).toBeUndefined()
    expect(window.view).toBe('tree')
    expect(window.mode).toBe('window')
    expect(window.position).toEqual({ x: 120, y: 80 })
    expect(window.size).toEqual({ width: 900, height: 700 })
  })
})
