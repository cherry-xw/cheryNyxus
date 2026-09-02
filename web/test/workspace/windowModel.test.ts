import { describe, expect, it } from 'vitest'
import {
  clampWorkspaceGeometry,
  createWorkspaceWindow,
  maximizedWorkspaceGeometry,
  parseWorkspaceLayout,
  serializeWorkspaceLayout,
} from '../../src/stores/workspace/windowModel'

describe('cyber workspace window model', () => {
  it('cascades new windows and keeps the titlebar reachable', () => {
    const first = createWorkspaceWindow(
      { resourceKey: 'session:a', title: 'A', context: { kind: 'session', chatId: 'a' } },
      0,
      { width: 1280, height: 720 },
    )
    const second = createWorkspaceWindow(
      { resourceKey: 'session:b', title: 'B', context: { kind: 'session', chatId: 'b' } },
      1,
      { width: 1280, height: 720 },
    )
    expect(second.geometry.x - first.geometry.x).toBe(28)
    expect(second.geometry.y - first.geometry.y).toBe(28)
    expect(clampWorkspaceGeometry({ x: 9999, y: -99, width: 900, height: 600 }, { width: 800, height: 600 })).toEqual(
      expect.objectContaining({ x: 764, y: 12, width: 776, height: 576 }),
    )
  })

  it('persists functional windows but not diagnostic windows', () => {
    const session = createWorkspaceWindow(
      { resourceKey: 'session:a', title: 'A', context: { kind: 'session', chatId: 'a' } },
      0,
    )
    const diagnostic = createWorkspaceWindow(
      {
        resourceKey: 'diagnostic:1',
        title: 'DIAGNOSTIC',
        context: { kind: 'diagnostic', severity: 'diagnostic', source: 'test', message: 'ok' },
      },
      1,
    )
    const snapshot = serializeWorkspaceLayout(
      { [session.id]: session, [diagnostic.id]: diagnostic },
      [session.id, diagnostic.id],
    )
    expect(snapshot.windows.map((window) => window.kind)).toEqual(['session'])
    expect(parseWorkspaceLayout(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot)
  })

  it('maximizes inside the desktop stage instead of covering system chrome', () => {
    expect(maximizedWorkspaceGeometry({ width: 1440, height: 830 })).toEqual({
      x: 0,
      y: 0,
      width: 1440,
      height: 830,
    })
  })

  it('accepts legacy persisted windows without restore geometry', () => {
    const window = createWorkspaceWindow(
      { resourceKey: 'session:legacy', title: 'Legacy', context: { kind: 'session', chatId: 'legacy' } },
      0,
    )
    const legacy = JSON.parse(JSON.stringify({ version: 1, order: [window.id], windows: [window] }))
    delete legacy.windows[0].restoreGeometry
    expect(parseWorkspaceLayout(legacy)?.windows).toHaveLength(1)
  })

  it('assigns a stable creation sequence separate from the z order', () => {
    const first = createWorkspaceWindow(
      { resourceKey: 'session:a', title: 'A', context: { kind: 'session', chatId: 'a' } },
      0,
    )
    const second = createWorkspaceWindow(
      { resourceKey: 'session:b', title: 'B', context: { kind: 'session', chatId: 'b' } },
      1,
      undefined,
      7,
    )
    expect(first.sequence).toBe(0)
    expect(second.sequence).toBe(7)

    const snapshot = serializeWorkspaceLayout(
      { [first.id]: first, [second.id]: second },
      [second.id, first.id],
    )
    expect(snapshot.order).toEqual([second.id, first.id])
    // windows 按 z 序输出；sequence 字段保持创建序不变（7 仍是后创建的 second）。
    expect(snapshot.windows.map((window) => window.sequence)).toEqual([7, 0])
  })

  it('keeps accepting persisted windows without a sequence field', () => {
    const window = createWorkspaceWindow(
      { resourceKey: 'session:legacy', title: 'Legacy', context: { kind: 'session', chatId: 'legacy' } },
      0,
    )
    const legacy = JSON.parse(JSON.stringify({ version: 1, order: [window.id], windows: [window] }))
    delete legacy.windows[0].sequence
    expect(parseWorkspaceLayout(legacy)?.windows).toHaveLength(1)
  })
})
