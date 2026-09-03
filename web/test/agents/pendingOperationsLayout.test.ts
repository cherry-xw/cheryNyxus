import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readComponentSource } from '../helpers/componentSource'

/**
 * 待操作面板「聚焦流水线」结构断言（2026-09-02 重构）：
 * 单层无嵌套 —— 状态头 + FOCUS CARD（唯一工作对象）+ QUEUE 队列缩略带；
 * 步进器一次一题、备注内嵌选项卡内；全直角、无 backdrop-filter、保留 light 主题覆盖。
 */
describe('pending operations focus pipeline layout', () => {
  it('focuses one task card over a queue strip instead of nested columns', async () => {
    const source = await readComponentSource(
      resolve(import.meta.dirname, '../../src/features/agent/attention/PendingOperationsPanel.vue'),
      'utf8',
    )
    const queueStrip = await readComponentSource(
      resolve(import.meta.dirname, '../../src/features/agent/attention/PendingQueueStrip.vue'),
      'utf8',
    )
    const stepper = await readComponentSource(
      resolve(import.meta.dirname, '../../src/features/agent/attention/QuestionStepper.vue'),
      'utf8',
    )

    // 新结构：聚焦卡 + 队列缩略带 + 步进器；根类与展开修饰符保持（WorkbenchDialog :deep 依赖）。
    expect(source).toContain('class="focus-card"')
    expect(source).toContain('PendingQueueStrip')
    expect(source).toContain('QuestionStepper')
    expect(source).toContain("'is-expanded'")
    expect(queueStrip).toContain('queue-chip')
    expect(stepper).toContain('step-dot')

    // 单层顺序：聚焦卡（含底部动作栏）在队列缩略带之前（lastIndexOf 取 template 用法，避开 import 行）。
    expect(source.indexOf('class="focus-card"')).toBeLessThan(
      source.lastIndexOf('<PendingQueueStrip'),
    )

    // 动作栏两类任务同位；提交前置禁用保留。
    expect(source).toContain('class="action-bar"')
    expect(source).toContain('提交当前任务回答')
    expect(source).toContain('canSubmitOf(activeItem)')

    // 备注内嵌选项卡内（不再出现独立的 option-row 追加式输入框）。
    expect(source).toContain('option-note')
    expect(source).toContain('is-selected')

    // 旧结构不残留。
    expect(source).not.toContain('task-nav-list')
    expect(source).not.toContain('question-step-nav')
    expect(source).not.toContain('panel-main')
    expect(source).not.toContain('side-col')
    expect(source).not.toContain('PAGE_SIZE')
    expect(source).not.toContain('selection-tier-label')
    expect(source).not.toContain('inset 3px 0 0')
  })

  it('keeps square styling and light-theme coverage in the panel styles', async () => {
    const source = await readComponentSource(
      resolve(import.meta.dirname, '../../src/features/agent/attention/PendingOperationsPanel.vue'),
      'utf8',
    )

    expect(source).toContain("html[data-theme='light']")
    expect(source).not.toContain('backdrop-filter')
    expect(source).not.toMatch(/border-radius:\s*(?!0)[1-9]/)
    expect(source).not.toContain('999px')
  })
})
