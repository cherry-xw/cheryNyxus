/**
 * memory_manage sense 单元测试。
 *
 * 覆盖：
 * - sense 定义：name/supervision
 * - add：缺参数 → 错误；正常添加
 * - remove：缺 name → 错误
 * - update：缺 name → 错误
 * - list：空/非空
 * - history：空/非空
 * - scope=workspace 无 workspace → 错误
 * - scope=global 正常
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import memorySense from '@/agent/sense/memory.js'
import { SupervisionLevel } from '@/core/config.js'
import * as memoryModule from '@/memory/index.js'

const exec = memorySense.executor.execute.bind(memorySense.executor)
const sharedData = new Map<string, Map<string, unknown>>()

describe('memory_manage sense 定义', () => {
  it('name = memory_manage', () => {
    expect(memorySense.definition.function.name).toBe('memory_manage')
  })

  it('supervision = auto', () => {
    expect(memorySense.supervisionLevel).toBe(SupervisionLevel.auto)
  })
})

describe('memory_manage add', () => {
  it('缺 name → 错误', async () => {
    const r = await exec(
      { action: 'add', scope: 'global', description: 'd', content: 'c', type: 'fact' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('错误')
  })

  it('缺 description → 错误', async () => {
    const r = await exec(
      { action: 'add', scope: 'global', name: 'test-mem', content: 'c', type: 'fact' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('错误')
  })

  it('缺 content → 错误', async () => {
    const r = await exec(
      { action: 'add', scope: 'global', name: 'test-mem', description: 'd', type: 'fact' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('错误')
  })

  it('缺 type → 错误', async () => {
    const r = await exec(
      { action: 'add', scope: 'global', name: 'test-mem', description: 'd', content: 'c' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('错误')
  })

  it('正常添加（mock addMemory ok）', async () => {
    vi.spyOn(memoryModule, 'addMemory').mockReturnValue({ ok: true } as never)
    const r = await exec(
      { action: 'add', scope: 'global', name: 'test-mem', description: 'd', content: 'c', type: 'fact' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('已添加')
    vi.restoreAllMocks()
  })

  it('addMemory 失败 → 错误消息', async () => {
    vi.spyOn(memoryModule, 'addMemory').mockReturnValue({ ok: false, error: '上限已满' } as never)
    const r = await exec(
      { action: 'add', scope: 'global', name: 'test-mem', description: 'd', content: 'c', type: 'fact' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('添加失败')
    vi.restoreAllMocks()
  })

  it('addMemory 淘汰旧记忆 → 含淘汰信息', async () => {
    vi.spyOn(memoryModule, 'addMemory').mockReturnValue({ ok: true, evicted: 'old-mem' } as never)
    const r = await exec(
      { action: 'add', scope: 'global', name: 'test-mem', description: 'd', content: 'c', type: 'fact' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('已淘汰')
    vi.restoreAllMocks()
  })
})

describe('memory_manage remove', () => {
  it('缺 name → 错误', async () => {
    const r = await exec({ action: 'remove', scope: 'global' }, sharedData, { chatId: 'test' })
    expect(r.content).toContain('错误')
  })

  it('removeMemory 失败 → 错误消息', async () => {
    vi.spyOn(memoryModule, 'removeMemory').mockReturnValue({ ok: false, error: '不存在' } as never)
    const r = await exec(
      { action: 'remove', scope: 'global', name: 'no-such' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('删除失败')
    vi.restoreAllMocks()
  })

  it('removeMemory 成功', async () => {
    vi.spyOn(memoryModule, 'removeMemory').mockReturnValue({ ok: true } as never)
    const r = await exec(
      { action: 'remove', scope: 'global', name: 'test-mem' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('已删除')
    vi.restoreAllMocks()
  })
})

describe('memory_manage update', () => {
  it('缺 name → 错误', async () => {
    const r = await exec({ action: 'update', scope: 'global' }, sharedData, { chatId: 'test' })
    expect(r.content).toContain('错误')
  })

  it('updateMemory 失败 → 错误消息', async () => {
    vi.spyOn(memoryModule, 'updateMemory').mockReturnValue({ ok: false, error: '不存在' } as never)
    const r = await exec(
      { action: 'update', scope: 'global', name: 'no-such', content: 'new' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('更新失败')
    vi.restoreAllMocks()
  })

  it('updateMemory 成功', async () => {
    vi.spyOn(memoryModule, 'updateMemory').mockReturnValue({ ok: true } as never)
    const r = await exec(
      { action: 'update', scope: 'global', name: 'test-mem', content: 'new' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('已更新')
    vi.restoreAllMocks()
  })
})

describe('memory_manage list', () => {
  it('空列表', async () => {
    vi.spyOn(memoryModule, 'listMemories').mockReturnValue([] as never)
    const r = await exec({ action: 'list', scope: 'global' }, sharedData, { chatId: 'test' })
    expect(r.content).toContain('0 条')
    expect(r.content).toContain('空')
    vi.restoreAllMocks()
  })

  it('非空列表', async () => {
    vi.spyOn(memoryModule, 'listMemories').mockReturnValue([
      { name: 'test-mem', description: 'desc', type: 'fact' },
    ] as never)
    const r = await exec({ action: 'list', scope: 'global' }, sharedData, { chatId: 'test' })
    expect(r.content).toContain('1 条')
    expect(r.content).toContain('test-mem')
    vi.restoreAllMocks()
  })
})

describe('memory_manage history', () => {
  it('空历史', async () => {
    vi.spyOn(memoryModule, 'listHistories').mockReturnValue([] as never)
    const r = await exec({ action: 'history', scope: 'global' }, sharedData, { chatId: 'test' })
    expect(r.content).toContain('0 条')
    vi.restoreAllMocks()
  })

  it('非空历史', async () => {
    vi.spyOn(memoryModule, 'listHistories').mockReturnValue([
      {
        name: 'old-mem',
        description: 'old desc',
        type: 'fact',
        replacedBy: 'new-mem',
        replacedAt: '2026-01-01',
        replacedReason: '淘汰',
      },
    ] as never)
    const r = await exec({ action: 'history', scope: 'global' }, sharedData, { chatId: 'test' })
    expect(r.content).toContain('1 条')
    expect(r.content).toContain('old-mem')
    expect(r.content).toContain('new-mem')
    vi.restoreAllMocks()
  })
})

describe('memory_manage scope=workspace', () => {
  it('无 workspace → 错误', async () => {
    const r = await exec(
      { action: 'list', scope: 'workspace' },
      sharedData,
      { chatId: 'test' },
    )
    expect(r.content).toContain('错误')
    expect(r.content).toContain('workspace')
  })
})
