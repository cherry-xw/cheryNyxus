import { afterEach, expect, it, vi } from 'vitest'
import { awaitTreeConfigBoundary, setTreeConfigBoundary } from '@/service/config/treeBoundary.js'

afterEach(() => setTreeConfigBoundary({ retry: async () => {}, admission: () => undefined }))

it('allows unrelated trees to start while an affected idle tree waits for MCP preparation', async () => {
  let finish!: () => void
  let pending = true
  const preparing = new Promise<void>((resolve) => {
    finish = resolve
  })
  setTreeConfigBoundary({
    retry: () => preparing,
    admission: (id) => (pending && id === 'affected' ? 'MCP pending' : undefined),
  })
  const admitted = vi.fn()
  const waiting = awaitTreeConfigBoundary('affected').then(admitted)
  try {
    await awaitTreeConfigBoundary('unrelated')
    expect(admitted).not.toHaveBeenCalled()
  } finally {
    pending = false
    finish()
    await waiting
  }
  expect(admitted).toHaveBeenCalledOnce()
})
