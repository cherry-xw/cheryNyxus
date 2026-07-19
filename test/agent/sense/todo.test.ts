/**
 * update_todo sense 单元测试。
 *
 * 覆盖：
 * - sense 定义：name/supervision
 * - 空列表 → "任务列表已清空"
 * - 非空列表 → 格式化输出
 * - activeForm 显示
 * - hash 生成
 */
import { describe, it, expect } from 'vitest'
import todoSense from '@/agent/sense/todo.js'
import { SupervisionLevel } from '@/core/config.js'

const exec = todoSense.executor.execute.bind(todoSense.executor)
const sharedData = new Map<string, Map<string, unknown>>()

describe('update_todo sense 定义', () => {
  it('name = update_todo', () => {
    expect(todoSense.definition.function.name).toBe('update_todo')
  })

  it('supervision = auto', () => {
    expect(todoSense.supervisionLevel).toBe(SupervisionLevel.auto)
  })
})

describe('update_todo handler', () => {
  it('空列表 → 已清空', async () => {
    const r = await exec({ todos: [] }, sharedData)
    expect(r.content).toContain('已清空')
    expect(r.hash).toBeTruthy()
  })

  it('单条 pending', async () => {
    const r = await exec(
      { todos: [{ content: '写测试', status: 'pending' }] },
      sharedData,
    )
    expect(r.content).toContain('写测试')
    expect(r.content).toContain('1 项')
    expect(r.content).toContain('[ ]')
  })

  it('in_progress 带 activeForm', async () => {
    const r = await exec(
      { todos: [{ content: '开发功能', status: 'in_progress', activeForm: '编码中' }] },
      sharedData,
    )
    expect(r.content).toContain('[→]')
    expect(r.content).toContain('编码中')
  })

  it('completed 状态', async () => {
    const r = await exec(
      { todos: [{ content: '完成设计', status: 'completed' }] },
      sharedData,
    )
    expect(r.content).toContain('[✓]')
  })

  it('多条混合状态', async () => {
    const r = await exec(
      {
        todos: [
          { content: '任务A', status: 'pending' },
          { content: '任务B', status: 'in_progress', activeForm: '进行中' },
          { content: '任务C', status: 'completed' },
        ],
      },
      sharedData,
    )
    expect(r.content).toContain('3 项')
    expect(r.content).toContain('[ ]')
    expect(r.content).toContain('[→]')
    expect(r.content).toContain('[✓]')
  })

  it('hash 非空', async () => {
    const r = await exec(
      { todos: [{ content: 'test', status: 'pending' }] },
      sharedData,
    )
    expect(r.hash).toBeTruthy()
  })

  it('不同 todos → 不同 hash', async () => {
    const r1 = await exec(
      { todos: [{ content: 'A', status: 'pending' }] },
      sharedData,
    )
    const r2 = await exec(
      { todos: [{ content: 'B', status: 'pending' }] },
      sharedData,
    )
    expect(r1.hash).not.toBe(r2.hash)
  })
})
