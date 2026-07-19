/**
 * processRegistry 单元测试。
 *
 * 覆盖：
 * - registerBashProcess：正常注册 / chatId 空 / pid undefined → 不注册
 * - unregisterBashProcess：正常清除 / 空 chatId / 不存在的 pid
 * - killBashProcess：命中 → killed=true + SIGTERM / 未命中 → false
 * - listBashProcesses：返回条目（不含 proc 句柄）
 * - 空 chat 清除（unregister 后 registry 清理）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  registerBashProcess,
  unregisterBashProcess,
  killBashProcess,
  listBashProcesses,
} from '@/agent/sense/processRegistry.js'

/** 构造 mock ChildProcess */
function mockProc(pid: number) {
  return {
    pid,
    kill: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    removeListener: vi.fn(),
  } as unknown as NodeJS.ChildProcess
}

describe('processRegistry register', () => {
  it('正常注册 → listBashProcesses 可查', () => {
    const proc = mockProc(12345)
    registerBashProcess('chat-1', proc, {
      command: 'echo hi',
      description: 'test',
      startedAt: Date.now(),
    })
    const list = listBashProcesses('chat-1')
    expect(list.length).toBe(1)
    expect(list[0]!.pid).toBe(12345)
    expect(list[0]!.command).toBe('echo hi')
    expect(list[0]!.killed).toBe(false)
    // 清理
    unregisterBashProcess('chat-1', 12345)
  })

  it('chatId 空 → 不注册', () => {
    const proc = mockProc(99999)
    registerBashProcess('', proc, {
      command: 'echo',
      description: 'x',
      startedAt: 0,
    })
    expect(listBashProcesses('')).toEqual([])
  })

  it('chatId undefined → 不注册', () => {
    const proc = mockProc(99999)
    registerBashProcess(undefined, proc, {
      command: 'echo',
      description: 'x',
      startedAt: 0,
    })
    // 不会出现在任何 chatId 下
    expect(listBashProcesses('undefined-chat')).toEqual([])
  })

  it('pid undefined → 不注册', () => {
    const proc = mockProc(undefined as unknown as number)
    registerBashProcess('chat-undef', proc, {
      command: 'echo',
      description: 'x',
      startedAt: 0,
    })
    expect(listBashProcesses('chat-undef')).toEqual([])
  })
})

describe('processRegistry unregister', () => {
  it('正常清除', () => {
    const proc = mockProc(22222)
    registerBashProcess('chat-unreg', proc, {
      command: 'ls',
      description: 'list',
      startedAt: 0,
    })
    expect(listBashProcesses('chat-unreg').length).toBe(1)
    unregisterBashProcess('chat-unreg', 22222)
    expect(listBashProcesses('chat-unreg')).toEqual([])
  })

  it('空 chatId → 不操作', () => {
    // 不应抛错
    unregisterBashProcess('', 12345)
    unregisterBashProcess(undefined, 12345)
  })

  it('不存在的 pid → 无影响', () => {
    const proc = mockProc(33333)
    registerBashProcess('chat-miss', proc, {
      command: 'pwd',
      description: 'dir',
      startedAt: 0,
    })
    unregisterBashProcess('chat-miss', 99999)
    expect(listBashProcesses('chat-miss').length).toBe(1)
    // 清理
    unregisterBashProcess('chat-miss', 33333)
  })

  it('清除后空 chat 从 registry 移除', () => {
    const proc = mockProc(44444)
    registerBashProcess('chat-empty', proc, {
      command: 'date',
      description: 'time',
      startedAt: 0,
    })
    unregisterBashProcess('chat-empty', 44444)
    expect(listBashProcesses('chat-empty')).toEqual([])
  })
})

describe('processRegistry killBashProcess', () => {
  it('命中 → killed=true + 返回 true', () => {
    const proc = mockProc(55555)
    registerBashProcess('chat-kill', proc, {
      command: 'sleep 10',
      description: 'wait',
      startedAt: 0,
    })
    // mock process.kill 全局
    const origKill = process.kill
    process.kill = vi.fn(() => true) as any
    const result = killBashProcess('chat-kill', 55555)
    expect(result).toBe(true)
    const list = listBashProcesses('chat-kill')
    expect(list[0]!.killed).toBe(true)
    process.kill = origKill
    // 清理
    unregisterBashProcess('chat-kill', 55555)
  })

  it('未命中 → 返回 false', () => {
    const result = killBashProcess('chat-noexist', 99999)
    expect(result).toBe(false)
  })

  it('进程组 kill 失败 → 兜底 proc.kill', () => {
    const proc = mockProc(66666)
    registerBashProcess('chat-fallback', proc, {
      command: 'cat',
      description: 'read',
      startedAt: 0,
    })
    const origKill = process.kill
    // process.kill(-pid) 抛错（进程组不存在）
    process.kill = vi.fn(() => {
      throw new Error('ESRCH')
    }) as any
    const result = killBashProcess('chat-fallback', 66666)
    expect(result).toBe(true)
    expect((proc as any).kill).toHaveBeenCalled()
    process.kill = origKill
    // 清理
    unregisterBashProcess('chat-fallback', 66666)
  })
})

describe('processRegistry listBashProcesses', () => {
  it('不存在的 chatId → []', () => {
    expect(listBashProcesses('no-such-chat')).toEqual([])
  })

  it('多进程注册', () => {
    const p1 = mockProc(11111)
    const p2 = mockProc(22222)
    registerBashProcess('chat-multi', p1, {
      command: 'cmd1',
      description: 'd1',
      startedAt: 100,
    })
    registerBashProcess('chat-multi', p2, {
      command: 'cmd2',
      description: 'd2',
      startedAt: 200,
    })
    const list = listBashProcesses('chat-multi')
    expect(list.length).toBe(2)
    // 条目不含 proc 句柄
    expect(list[0]).not.toHaveProperty('proc')
    expect(list[1]).not.toHaveProperty('proc')
    // 清理
    unregisterBashProcess('chat-multi', 11111)
    unregisterBashProcess('chat-multi', 22222)
  })
})
