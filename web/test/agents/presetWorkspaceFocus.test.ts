import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useAgentsStore } from '../../src/stores/agents'
import type { PetInstance } from '../../src/features/pets/types/types'

describe('preset workspace active root', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('switches the active root without mutating stable Pet identity', () => {
    const store = useAgentsStore()
    const pet = {
      instanceId: 'pet-1',
      isMaster: true,
      chatId: 'root-original',
      presetId: 'preset-1',
      preset: 'assistant',
      isWorking: false,
      isGhost: false,
      action: 'walk',
      mood: 'calm',
    } as unknown as PetInstance
    store.pets.push(pet)
    store.historyList = [
      { chatId: 'root-original', presetId: 'preset-1', preset: 'assistant' },
      { chatId: 'root-latest', presetId: 'preset-1', preset: 'assistant' },
    ]

    store.activatePresetSession('preset-1', 'root-latest')

    expect(pet.chatId).toBe('root-original')
    expect(store.activeRootForPet(pet)).toBe('root-latest')
    expect(store.petForChat('root-latest')?.instanceId).toBe(pet.instanceId)
  })

  it('projects working state from the selected root onto its workspace Pet', () => {
    const store = useAgentsStore()
    const pet = {
      instanceId: 'pet-1',
      isMaster: true,
      chatId: 'root-original',
      presetId: 'preset-1',
      preset: 'assistant',
      isWorking: false,
      isGhost: false,
      action: 'walk',
      mood: 'calm',
    } as unknown as PetInstance
    store.pets.push(pet)
    store.historyList = [
      { chatId: 'root-original', presetId: 'preset-1', preset: 'assistant' },
      { chatId: 'root-latest', presetId: 'preset-1', preset: 'assistant' },
    ]

    store.activatePresetSession('preset-1', 'root-latest')
    store.setWorkingForChat('root-latest', true)

    expect(pet.isWorking).toBe(true)
    expect(pet.action).toBe('chatting')
  })

  it('does not project an inactive background root onto the visible Pet bubble', () => {
    const store = useAgentsStore()
    const pet = {
      instanceId: 'pet-1',
      isMaster: true,
      chatId: 'root-visible',
      presetId: 'preset-1',
      preset: 'assistant',
      isWorking: false,
      isGhost: false,
      action: 'walk',
      mood: 'calm',
    } as unknown as PetInstance
    store.pets.push(pet)
    store.historyList = [
      { chatId: 'root-visible', presetId: 'preset-1', preset: 'assistant' },
      { chatId: 'root-background', presetId: 'preset-1', preset: 'assistant' },
    ]

    store.setWorkingForChat('root-background', true)

    expect(pet.isWorking).toBe(false)
    expect(pet.action).toBe('walk')
  })

  it('tracks and clears a workbench-docked history drawer anchor', () => {
    const store = useAgentsStore()
    const anchor = { top: 20, left: 30, width: 900, height: 700 }

    store.openHistoryRoot('root-visible', 'workbench-docked', anchor)

    expect(store.historyDrawerMode).toBe('workbench-docked')
    expect(store.historyDrawerAnchor).toEqual(anchor)
    expect(store.historyDrawerStack).toEqual(['root-visible'])

    store.closeHistoryTop()

    expect(store.historyDrawerMode).toBe('overlay')
    expect(store.historyDrawerAnchor).toBeNull()
  })

  it('keeps minimized workbench state alive without claiming the overlay focus', () => {
    const store = useAgentsStore()
    store.activeDialogChatId = 'root-visible'
    store.activeDialogView = 'tree'
    store.openHistoryRoot('root-visible', 'workbench-docked', {
      top: 0,
      left: 0,
      width: 900,
      height: 700,
    })

    store.workbenchMinimized = true

    expect(store.activeDialogChatId).toBe('root-visible')
    expect(store.activeDialogView).toBe('tree')
    expect(store.historyDrawerStack).toEqual(['root-visible'])
    expect(store.topOverlay).toBeNull()

    store.workbenchMinimized = false
    expect(store.topOverlay).toBe('historyDrawer')
  })
})
