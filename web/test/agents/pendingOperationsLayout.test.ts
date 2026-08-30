import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

describe('pending operations layout', () => {
  it('expresses task/question nesting structurally and scopes actions to the active task', async () => {
    const source = await readComponentSource(
      resolve(import.meta.dirname, '../../src/features/agent/attention/PendingOperationsPanel.vue'),
      'utf8',
    )

    expect(source).toContain('task-nav-list')
    expect(source).toContain('question-step-nav')
    expect(source).toContain('class="panel-main"')
    expect(source).toContain('class="questions"')
    expect(source).toContain('activeQuestion')
    expect(source).toContain('technical-details')
    expect(source).toContain('current-task-actions')
    expect(source).toContain('提交当前任务回答')
    expect(source.indexOf('class="current-task-actions"')).toBeLessThan(
      source.indexOf('class="side-col"'),
    )
    expect(source).not.toContain('selection-tier-label')
    expect(source).toContain("html[data-theme='light']")
    expect(source).not.toContain('inset 3px 0 0')
  })
})
