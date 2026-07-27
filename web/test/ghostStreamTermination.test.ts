import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { createStreamRouter } from '../src/stores/agents/ui/streamRouter'
import type { PetInstance } from '../src/features/pets/types/types'
import type { StreamState } from '../src/stores/agents/types'

function makeChildPet(overrides: Partial<PetInstance> = {}): PetInstance {
  return {
    instanceId: 'child-pet',
    tribe: 'master-pet',
    isMaster: false,
    isGhost: false,
    isWorking: true,
    canResume: true,
    chatId: 'child-chat',
    action: 'chatting',
    interactionUntil: 0,
    moodUntil: 0,
    bubbleRepelExtra: 80,
    ...overrides,
  } as PetInstance
}

function makeRouter(pet: PetInstance) {
  const streams = ref<Record<string, StreamState>>({})
  const pets = ref([pet])
  const router = createStreamRouter(
    streams,
    pets,
    new Map(),
    (target, working) => {
      if (target) target.isWorking = working
    },
    () => {},
    async () => {},
    async () => {},
    () => '👻',
    ref([]),
  )
  return { streams, router }
}

describe('child ghost stream termination', () => {
  it('clears the child loading state when watchdog abandons it', () => {
    const pet = makeChildPet()
    const { streams, router } = makeRouter(pet)
    const stream = router.ensureStream('child-chat')
    stream.isWorking = true
    stream.activeRunId = 'run-1'
    stream.thinking = 'thinking'
    stream.content = 'content'

    router.routeNotification({
      type: 'child_abandoned',
      data: { childChatId: 'child-chat' },
    })

    expect(pet.isGhost).toBe(true)
    expect(pet.isWorking).toBe(false)
    expect(streams.value['child-chat']).toMatchObject({
      isWorking: false,
      thinking: '',
      content: '',
    })
    expect(streams.value['child-chat']?.activeRunId).toBeUndefined()
  })

  it('does not revive a ghost from a delayed stream chunk', () => {
    const pet = makeChildPet({ isGhost: true, isWorking: false })
    const { router } = makeRouter(pet)
    const stream = router.ensureStream('child-chat')

    router.routeChunk({
      type: 'stream',
      requestId: 'late-request',
      chatId: 'child-chat',
      runId: 'run-1',
      data: { content: 'late content' },
    })

    expect(pet.isWorking).toBe(false)
    expect(stream.isWorking).toBe(false)
    expect(stream.content).toBe('')
  })
})
