import { describe, expect, it } from 'vitest'
import { frameCoordinator } from '../../src/utils/frameCoordinator'

describe('frame coordinator lifecycle', () => {
  it('deduplicates subscribers and stops after the final unsubscribe', () => {
    const subscriber = () => undefined
    const unsubscribeFirst = frameCoordinator.subscribe(subscriber)
    const unsubscribeDuplicate = frameCoordinator.subscribe(subscriber)
    expect(frameCoordinator.subscriberCount).toBe(1)

    unsubscribeDuplicate()
    expect(frameCoordinator.subscriberCount).toBe(0)
    unsubscribeFirst()
    expect(frameCoordinator.subscriberCount).toBe(0)
  })
})
