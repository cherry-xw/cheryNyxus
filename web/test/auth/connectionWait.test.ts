import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'

const mock = vi.hoisted(() => ({
  callbacks: new Set<(status: string) => void>(),
  connect: vi.fn(),
  disconnect: vi.fn(),
}))
vi.mock('@/services/ws', () => ({
  wsClient: {
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
  })
  it('reports timeout and cleans observers so the form can retry', async () => {
    vi.useFakeTimers()
    const conn = useConnectionStore()
    const promise = conn.reconnect({ waitUntilConnected: true })
    await vi.advanceTimersByTimeAsync(15_000)
    await promise
    expect(conn.error).toContain('超时')
    expect(conn.status).toBe('disconnected')
    expect(mock.disconnect).toHaveBeenCalledOnce()
    expect(mock.callbacks.size).toBe(0)
  })
})
