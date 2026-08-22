import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentsStore } from '../../src/stores/agents'
import type { ChatSummary } from '../../src/services/agentApi'

/**
 * 接力棒（baton pass）判定：pet 气泡的提问/审批应仅当没有任何打开的工作台窗口覆盖其根会话时
 * 才由 pet 层展示；工作台打开（且未最小化）时由工作台消费，关闭/最小化后交还 pet（最终兜底）。
 * 纯 store 层单测（不挂 RPC）：直接操作 workbenchWindows 状态与 historyList 目录。
 */
describe('workbench relay (baton pass)', () => {
  beforeEach(() => setActivePinia(createPinia()))

  function seedStore() {
    const store = useAgentsStore()
    const catalog: ChatSummary[] = [
      { chatId: 'root-a', presetId: 'preset-a', preset: 'assistant' },
      { chatId: 'child-1', presetId: 'preset-a', preset: 'assistant', parentChatId: 'root-a' },
      { chatId: 'root-b', presetId: 'preset-b', preset: 'researcher' },
    ]
    store.historyList = catalog
    return { store, catalog }
  }

  it('resolves a chat to its ancestor root (self for roots / unknown)', () => {
    const { store } = seedStore()
    expect(store.rootChatForChat('root-a')).toBe('root-a')
    expect(store.rootChatForChat('child-1')).toBe('root-a')
    expect(store.rootChatForChat('root-b')).toBe('root-b')
    // 目录中不存在的 chat（未水合/幽灵）回退为自身
    expect(store.rootChatForChat('unknown-chat')).toBe('unknown-chat')
  })

  it('is consumed only when an open, unminimized workbench covers the root', () => {
    const { store } = seedStore()
    // 无工作台窗口 → pet 兜底
    expect(store.workbenchConsumesChat('root-a')).toBe(false)
    expect(store.workbenchConsumesChat('child-1')).toBe(false)

    // 打开 preset-a 的工作台并指向 root-a → 根与整棵后代都被接管
    const id = store.openWorkbenchWindow('preset-a', 'assistant')
    store.setWorkbenchWindowChat(id, 'root-a')
    expect(store.workbenchConsumesChat('root-a')).toBe(true)
    expect(store.workbenchConsumesChat('child-1')).toBe(true)
    // 其它根不受影响
    expect(store.workbenchConsumesChat('root-b')).toBe(false)

    // 最小化 → 交还 pet
    store.setWorkbenchWindowMinimized(id, true)
    expect(store.workbenchConsumesChat('root-a')).toBe(false)
    store.setWorkbenchWindowMinimized(id, false)
    expect(store.workbenchConsumesChat('root-a')).toBe(true)

    // 关闭 → 交还 pet
    store.closeWorkbenchWindow(id)
    expect(store.workbenchConsumesChat('root-a')).toBe(false)
  })

  it('ignores workbench windows that are open but on a different root', () => {
    const { store } = seedStore()
    const id = store.openWorkbenchWindow('preset-a', 'assistant')
    store.setWorkbenchWindowChat(id, 'root-b')
    // 窗口显示 root-b，root-a 的 pet 交互仍归 pet 兜底
    expect(store.workbenchConsumesChat('root-a')).toBe(false)
    expect(store.workbenchConsumesChat('root-b')).toBe(true)
  })
})
