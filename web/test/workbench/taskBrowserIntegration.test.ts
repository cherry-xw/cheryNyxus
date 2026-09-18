import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { TaskOverview } from '../../src/services/agentApi'
import { readComponentSourceSync } from '../helpers/componentSource'
import {
  canMarkTaskResultViewed,
  taskAfterArchive,
  useTaskBrowserOverlay,
} from '../../src/features/agent/workbench/useTaskBrowserOverlay'

function task(id: string, updatedAt = 0, presetId = 'preset-a'): TaskOverview {
  return {
    rootChatId: id,
    taskKey: id,
    originalChatId: id,
    openChatId: id,
    presetId,
    title: id,
    status: 'completed',
    updatedAt,
    pendingCount: 0,
    hasFailure: false,
    agents: [],
    recentEvents: [],
    branchCount: 1,
    unreadResult: true,
    attentionKey: `attention-${id}`,
    latestResult: { resultId: `result-${id}`, status: 'completed', completedAt: updatedAt },
  }
}

describe('task browser workbench integration', () => {
  it('isolates overlay state by workbench and resets it when the window is destroyed', () => {
    const first = useTaskBrowserOverlay('window-a')
    const second = useTaskBrowserOverlay('window-b')

    first.open({ focus: 'attention' })
    expect(first.state.value).toMatchObject({ open: true, entryFocus: 'attention' })
    expect(second.state.value.open).toBe(false)

    first.dispose()
    expect(first.state.value).toMatchObject({ open: false, entryFocus: 'all' })
    second.dispose()
  })

  it('marks a result viewed only after the selected task is loaded in a foreground uncovered window', () => {
    const done = task('done', 5)
    const ready = {
      task: done,
      currentChatId: 'done',
      loadedChatId: 'done',
      loading: false,
      foreground: true,
      taskBrowserOpen: false,
    }

    expect(canMarkTaskResultViewed(ready)).toBe(true)
    expect(canMarkTaskResultViewed({ ...ready, loadedChatId: 'old' })).toBe(false)
    expect(canMarkTaskResultViewed({ ...ready, foreground: false })).toBe(false)
    expect(canMarkTaskResultViewed({ ...ready, taskBrowserOpen: true })).toBe(false)
  })

  it('does not overwrite a user switch while archiving and clears only when no task remains', () => {
    const archived = ['current', 'current-branch']
    const tasks = [task('current', 3), task('next', 2), task('other-preset', 9, 'preset-b')]

    expect(
      taskAfterArchive({
        tasks,
        taskKey: 'current',
        archivedChatIds: archived,
        activeChatIdAtStart: 'current',
        currentChatId: 'manually-selected',
        presetId: 'preset-a',
      }),
    ).toEqual({ change: false })
    expect(
      taskAfterArchive({
        tasks,
        taskKey: 'current',
        archivedChatIds: archived,
        activeChatIdAtStart: 'current',
        currentChatId: null,
        presetId: 'preset-a',
      }),
    ).toEqual({ change: true, chatId: 'next' })
    expect(
      taskAfterArchive({
        tasks: [task('current', 3)],
        taskKey: 'current',
        archivedChatIds: archived,
        activeChatIdAtStart: 'current',
        currentChatId: 'current',
        presetId: 'preset-a',
      }),
    ).toEqual({ change: true, chatId: null })
  })

  it('mounts the page inside the workbench and removes the dropdown implementation', () => {
    const dialog = readComponentSourceSync(
      resolve('src/features/agent/workbench/WorkbenchDialog.vue'),
    )
    const bar = readComponentSourceSync(
      resolve('src/features/agent/workbench/WorkbenchSessionBar.vue'),
    )
    const workbenchSource = existsSync(resolve('src/features/agent/workbench'))
      ? resolve('src/features/agent/workbench')
      : resolve('web/src/features/agent/workbench')

    expect(dialog).toContain('<TaskBrowser')
    expect(dialog).toContain(':inert="taskBrowserState.open || undefined"')
    expect(bar).toContain('useTaskBrowserOverlay')
    expect(bar).not.toContain('SessionDropdown')
    expect(existsSync(resolve(workbenchSource, 'SessionDropdown.vue'))).toBe(false)
    expect(existsSync(resolve(workbenchSource, 'useSessionDropdown.ts'))).toBe(false)
  })
})
