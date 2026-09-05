import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

async function component(name: string): Promise<string> {
  return readComponentSource(
    resolve(import.meta.dirname, `../../src/features/agent/task-center/${name}.vue`),
    'utf8',
  )
}

describe('task center information architecture', () => {
  it('separates lifecycle filtering from the user action workspace', async () => {
    const panel = await component('TaskCenterPanel')

    expect(panel).not.toContain('PendingOperationsPanel')
    expect(panel).toContain('TaskCenterAttentionWorkspace')
    expect(panel).toContain("workspaceMode = ref<WorkspaceMode>('overview')")
    expect(panel).toContain("type TaskFilter = 'unfinished' | 'completed' | 'all'")
    expect(panel).toContain("task.status !== 'completed'")
    expect(panel).toContain('未完成')
    expect(panel).toContain('本次完成')
    expect(panel).toContain('当前任务中心保留的所有任务')
    expect(panel).toContain('已关注')
  })

  it('explains decisions and provides both inline and source details', async () => {
    const [panel, attention] = await Promise.all([
      component('TaskCenterPanel'),
      component('TaskCenterAttentionWorkspace'),
    ])

    expect(attention).toContain('InteractionDecisionContext')
    expect(attention).toContain('这些操作必须由你确认或回答后')
    expect(attention).toContain('查看原详情 ↗')
    expect(attention).toContain('await interactions.decide(item, action)')
    expect(attention).toContain('await interactions.answer(item, answers)')
    expect(panel).toContain("view: 'tree'")
    expect(panel).toContain("workspace.setWorkbenchWindowView(windowId, 'tree')")
  })
})
