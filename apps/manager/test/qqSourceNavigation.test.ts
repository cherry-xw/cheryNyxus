import { nextTick } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { hasRangeSources, revealSourceTarget, sourceGapHeading, sourceReturnTarget } from '../../../plugins/qq/ui/sourceNavigation'

const target = () => ({ isConnected: true, focus: vi.fn(), scrollIntoView: vi.fn() })

describe('QQ source reading navigation without a browser', () => {
  it('distinguishes range reasons and only offers reading for known omitted messages', () => {
    const reasons = ['history_start', 'omitted_from_context', 'reception_unconfirmed', 'source_deleted'] as const
    expect(reasons.map(sourceGapHeading)).toEqual(['本地记录起点', '未纳入本次输入的消息', '接收情况未确认', '来源已删除'])
    for (const reason of reasons) {
      expect(hasRangeSources({ itemId: 'gap', position: 0, type: 'gap', reason, relationId: 'relation', knownMessageCount: 16 })).toBe(reason === 'omitted_from_context')
    }
    expect(hasRangeSources({ itemId: 'gap', position: 0, type: 'gap', reason: 'omitted_from_context', relationId: 'relation', knownMessageCount: 0 })).toBe(false)
    expect(hasRangeSources({ itemId: 'gap', position: 0, type: 'gap', reason: 'omitted_from_context', relationId: 'relation' })).toBe(false)
  })

  it('resolves the target after the update and focuses it with an immediate reveal', async () => {
    const element = target()
    let mounted: ReturnType<typeof target> | undefined
    const reading = revealSourceTarget(() => mounted, () => true)
    expect(element.focus).not.toHaveBeenCalled()
    mounted = element
    await reading
    expect(element.focus).toHaveBeenCalledWith({ preventScroll: true })
    expect(element.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' })
    expect(element.focus.mock.invocationCallOrder[0]).toBeLessThan(element.scrollIntoView.mock.invocationCallOrder[0]!)
  })

  it('does not wait for a network response to reveal loading feedback', async () => {
    const element = target()
    let resolve!: () => void
    const network = new Promise<void>(done => { resolve = done })
    const reading = revealSourceTarget(() => element, () => true)
    await nextTick()
    expect(element.focus).toHaveBeenCalledOnce()
    resolve()
    await Promise.all([network, reading])
  })

  it('does not focus a stale selection, a replaced relation, or an unmounted target', async () => {
    const stale = target(), removed = { ...target(), isConnected: false }
    let current = true
    const reading = revealSourceTarget(() => stale, () => current)
    current = false
    await reading
    await revealSourceTarget(() => removed, () => true)
    await revealSourceTarget(() => undefined, () => true)
    expect(stale.focus).not.toHaveBeenCalled()
    expect(stale.scrollIntoView).not.toHaveBeenCalled()
    expect(removed.focus).not.toHaveBeenCalled()
  })

  it('only reveals the last requested target when a newer navigation replaces it', async () => {
    const first = target(), second = target()
    let version = 1
    const old = revealSourceTarget(() => first, () => version === 1)
    version = 2
    const latest = revealSourceTarget(() => second, () => version === 2)
    await Promise.all([old, latest])
    expect(first.focus).not.toHaveBeenCalled()
    expect(second.focus).toHaveBeenCalledOnce()
  })

  it('can reveal the original trigger on return without querying or altering model selection', async () => {
    const origin = target(), selection = { snapshotId: 'snapshot', projectionId: 'projection' }
    const before = { ...selection }
    await revealSourceTarget(() => origin, () => true)
    expect(origin.focus).toHaveBeenCalledOnce()
    expect(selection).toEqual(before)
  })

  it('uses the still-connected original trigger without looking for another element', () => {
    const origin = { ...target(), id: 'source-trigger-request:item:part' }, lookup = vi.fn()
    expect(sourceReturnTarget(origin, lookup)).toBe(origin)
    expect(lookup).not.toHaveBeenCalled()
  })

  it('finds the same stable trigger after a module regroup replaces its element', async () => {
    const id = 'source-trigger-request:item:part', origin = { ...target(), id, isConnected: false }
    const replacement = { ...target(), id }
    let mounted: typeof replacement | null = null
    const lookup = vi.fn(() => mounted)
    const reading = revealSourceTarget(() => sourceReturnTarget(origin, lookup), () => true)
    mounted = replacement
    await reading
    expect(lookup).toHaveBeenCalledWith(id)
    expect(replacement.focus).toHaveBeenCalledOnce()
    expect(replacement.scrollIntoView).toHaveBeenCalledOnce()
    expect(origin.focus).not.toHaveBeenCalled()
  })

  it('does not guess another trigger when the original item no longer exists or has no stable ID', () => {
    const lookup = vi.fn(() => null)
    expect(sourceReturnTarget({ id: 'gone', isConnected: false }, lookup)).toBeUndefined()
    expect(lookup).toHaveBeenCalledExactlyOnceWith('gone')
    expect(sourceReturnTarget({ id: '', isConnected: false }, lookup)).toBeUndefined()
    expect(sourceReturnTarget(undefined, lookup)).toBeUndefined()
    expect(lookup).toHaveBeenCalledOnce()
  })
})
