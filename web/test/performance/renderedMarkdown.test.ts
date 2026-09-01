import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  renderMarkdownAsync: vi.fn<(source: string) => Promise<string>>(),
}))
vi.mock('@/utils/markdownClient', () => ({ renderMarkdownAsync: mocks.renderMarkdownAsync }))

import { useRenderedMarkdown } from '../../src/composables/useRenderedMarkdown'

describe('rendered markdown scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.renderMarkdownAsync.mockReset()
    mocks.renderMarkdownAsync.mockImplementation(async (source) => `<p>${source}</p>`)
  })

  afterEach(() => vi.useRealTimers())

  it('renders the leading value, resets empty input, and trails updates at 240ms', async () => {
    const source = ref('first')
    const scope = effectScope()
    const state = scope.run(() => useRenderedMarkdown(source, { mode: 'full' }))!
    await nextTick()
    await Promise.resolve()
    expect(state.html.value).toBe('<p>first</p>')

    source.value = 'second'
    await nextTick()
    await vi.advanceTimersByTimeAsync(239)
    expect(mocks.renderMarkdownAsync).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.renderMarkdownAsync).toHaveBeenCalledTimes(2)

    source.value = ''
    await nextTick()
    expect(state.html.value).toBe('')
    scope.stop()
  })

  it('rejects stale async results after a newer flush', async () => {
    const resolvers = new Map<string, (html: string) => void>()
    mocks.renderMarkdownAsync.mockImplementation(
      (source) => new Promise((resolve) => resolvers.set(source, resolve)),
    )
    const source = ref('old')
    const scope = effectScope()
    const state = scope.run(() => useRenderedMarkdown(source, { mode: 'full' }))!
    await nextTick()

    source.value = 'new'
    await nextTick()
    state.flush()
    resolvers.get('new')?.('<p>new</p>')
    await Promise.resolve()
    expect(state.html.value).toBe('<p>new</p>')

    resolvers.get('old')?.('<p>old</p>')
    await Promise.resolve()
    expect(state.html.value).toBe('<p>new</p>')
    scope.stop()
  })
})
