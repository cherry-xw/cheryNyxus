import { describe, expect, it } from 'vitest'
import { terminationDisplay } from '../../../src/features/pets/nyxus/graph/termination'
import { terminationFacts } from '../../fixtures/executionGraphFixtures'

describe('termination presentation', () => {
  it('maps every durable code without exposing audit detail', () => {
    const displays = terminationFacts().map(terminationDisplay)
    expect(displays.map((item) => item.label)).toEqual([
      '用户手动截断',
      '系统停止',
      '看门狗超时停止',
      '执行错误终止',
      '主 Agent 已重定向任务',
      '达到保护性限制，已暂停',
    ])
    expect(displays.every((item) => !('detail' in item))).toBe(true)
  })
})
