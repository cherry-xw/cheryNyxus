import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  callbacks: new Set<(status: string) => void>(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  rpc: vi.fn(),
}))
vi.mock('@/services/ws', () => ({
  wsClient: {
    rpc: mock.rpc,
    connect: mock.connect,
    disconnect: mock.disconnect,
    onStatus: (fn: (status: string) => void) => {
      mock.callbacks.add(fn)
      return () => mock.callbacks.delete(fn)
    },
  },
}))
import { useConnectionStore } from '../../src/stores/connection'

beforeEach(() => {
  setActivePinia(createPinia())
  mock.callbacks.clear()
  vi.clearAllMocks()
  mock.connect.mockResolvedValue(undefined)
  mock.rpc.mockResolvedValue({ success: true })
})
afterEach(() => vi.useRealTimers())

describe('explicit connection completion', () => {
  it('does not resolve at socket creation; waits for connected', async () => {
    const conn = useConnectionStore()
    let done = false
    const promise = conn.reconnect({ waitUntilConnected: true }).then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    for (const fn of mock.callbacks) fn('connected')
    await promise
    expect(conn.status).toBe('connected')
    expect(conn.error).toBeNull()
    expect(mock.callbacks.size).toBe(0)
    expect(mock.rpc).toHaveBeenCalledWith('chat.list', { scope: 'stage', limit: 1, includePreview: false })
  })
  it('waits for a successful business read after the socket is open', async () => {
    let reply!: (value: { success: boolean }) => void
    mock.rpc.mockReturnValueOnce(new Promise((resolve) => { reply = resolve }))
    const conn = useConnectionStore()
    let done = false
    const pending = conn.reconnect({ waitUntilConnected: true }).then(() => { done = true })
    for (const fn of mock.callbacks) fn('connected')
    await vi.waitFor(() => expect(mock.rpc).toHaveBeenCalledOnce())
    expect(done).toBe(false)
    reply({ success: true })
    await pending
    expect(done).toBe(true)
  })
  it.each([{ success: false }, { success: true, error: { code: 'INVALID_PARAMS' } }])('does not enter the workbench after failed readback: %j', async (response) => {
    mock.rpc.mockResolvedValueOnce(response)
    const conn = useConnectionStore()
    const pending = conn.reconnect({ waitUntilConnected: true })
    const rejected = expect(pending).rejects.toThrow('业务读取失败')
    for (const fn of mock.callbacks) fn('connected')
    await rejected
    expect(conn.status).toBe('disconnected')
    expect(mock.disconnect).toHaveBeenCalledOnce()
    expect(mock.callbacks.size).toBe(0)
  })
  it('reports timeout and cleans observers so the form can retry', async () => {
    vi.useFakeTimers()
    const conn = useConnectionStore()
    const promise = conn.reconnect({ waitUntilConnected: true })
    const rejected = expect(promise).rejects.toThrow('超时')
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(conn.error).toContain('超时')
    expect(conn.status).toBe('disconnected')
    expect(mock.disconnect).toHaveBeenCalledOnce()
    expect(mock.callbacks.size).toBe(0)
  })
})
