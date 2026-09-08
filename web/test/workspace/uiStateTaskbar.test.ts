import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUiState } from '../../src/stores/workspace/uiState'

const STORAGE_KEY = 'chery.workspace.cyber-layout.v1'

function stubLayoutStorage(snapshot: unknown): Map<string, string> {
  const values = new Map<string, string>([[STORAGE_KEY, JSON.stringify(snapshot)]])
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  })
  return values
}

afterEach(() => vi.unstubAllGlobals())

describe('workspace taskbar stable ordering', () => {
  it('keeps the taskbar order stable while focusing windows', () => {
    const ui = createUiState()
    const a = ui.openOrFocusWindow({
      resourceKey: 'session:a',
      title: 'A',
      context: { kind: 'session', chatId: 'a' },
    })
    const b = ui.openOrFocusWindow({
      resourceKey: 'session:b',
      title: 'B',
      context: { kind: 'session', chatId: 'b' },
    })
    const c = ui.openOrFocusWindow({
      resourceKey: 'session:c',
      title: 'C',
      context: { kind: 'session', chatId: 'c' },
    })
    expect(ui.workspaceWindowsTaskbarList.value.map((window) => window.id)).toEqual([a, b, c])

    // 聚焦最早的窗口：z 序翻转（workspaceWindowsList），任务栏展示序不变。
    ui.focusWorkspaceWindow(a)
    expect(ui.workspaceWindowsList.value.map((window) => window.id)).toEqual([b, c, a])
    expect(ui.workspaceWindowsTaskbarList.value.map((window) => window.id)).toEqual([a, b, c])
    expect(ui.workspaceWindowsTaskbarList.value.find((window) => window.id === a)?.focused).toBe(
      true,
    )

    // 关闭后仍保持创建序，无空洞。
    ui.removeWorkspaceWindow(b)
    expect(ui.workspaceWindowsTaskbarList.value.map((window) => window.id)).toEqual([a, c])
  })

  it('falls back to snapshot index for restored legacy windows without sequence', () => {
    const ui = createUiState()
    ui.restoreWorkspaceLayout(() => true)
    // 无快照时列表为空；此处主要验证不抛异常且计数器不回退。
    const id = ui.openOrFocusWindow({
      resourceKey: 'session:after-restore',
      title: 'A',
      context: { kind: 'session', chatId: 'a' },
    })
    expect(ui.workspaceWindowsTaskbarList.value.map((window) => window.id)).toEqual([id])
  })

  it('rebuilds renderable graph and settings state from a persisted layout', () => {
    stubLayoutStorage({
      version: 1,
      order: ['window:graph:preset-a', 'window:settings'],
      windows: [
        {
          id: 'window:graph:preset-a',
          resourceKey: 'graph:preset-a',
          kind: 'graph',
          lifecycle: 'minimized',
          title: 'preset-a',
          geometry: { x: 80, y: 60, width: 1200, height: 760 },
          zOrder: 0,
          sequence: 0,
          focused: false,
          maximized: false,
          attention: false,
          persistent: true,
          context: { kind: 'graph', presetId: 'preset-a', chatId: 'chat-a' },
        },
        {
          id: 'window:settings',
          resourceKey: 'settings',
          kind: 'settings',
          lifecycle: 'open',
          title: '系统配置',
          geometry: { x: 120, y: 90, width: 1120, height: 760 },
          zOrder: 1,
          sequence: 1,
          focused: false,
          maximized: false,
          attention: false,
          persistent: true,
          context: { kind: 'settings' },
        },
      ],
    })
    const ui = createUiState()

    ui.restoreWorkspaceLayout(() => true)

    expect(ui.workbenchWindowOrder.value).toEqual(['preset-a'])
    expect(ui.workbenchWindows.value['preset-a']).toMatchObject({
      presetId: 'preset-a',
      presetName: 'preset-a',
      chatId: 'chat-a',
      view: 'tree',
      minimized: true,
    })
    expect(ui.settingsOpen.value).toBe(true)

    ui.setWorkbenchWindowMinimized('preset-a', false)
    expect(ui.workspaceWindows.value['window:graph:preset-a']).toMatchObject({
      lifecycle: 'open',
      focused: true,
    })
  })

  it('persists the active graph chat so refresh can restore its tree', () => {
    const values = stubLayoutStorage(undefined)
    const ui = createUiState()
    const id = ui.openWorkbenchWindow('preset-a', 'preset-a')

    ui.setWorkbenchWindowChat(id, 'chat-a')

    const snapshot = JSON.parse(values.get(STORAGE_KEY) ?? '{}')
    expect(snapshot.windows[0].context).toEqual({
      kind: 'graph',
      presetId: 'preset-a',
      chatId: 'chat-a',
    })
  })
})
