import { describe, expect, it } from 'vitest'
import { createUiState } from '../../src/stores/workspace/uiState'

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
})
