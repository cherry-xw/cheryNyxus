import { afterEach, describe, expect, it } from 'vitest'
import { configureInputAdoption, canAdoptInput, canContinueInstruction, reserveInputs, isReservedInput, isReservedInputId, releaseReservedInputs } from '@/core/middleware/inputAdoption.js'
import type { UserInputEntry } from '@/core/middleware/types.js'

describe('input adoption boundary', () => {
  afterEach(() => configureInputAdoption(undefined))
  it('allows an adopted instruction to resume without admitting the next queued input', () => {
    configureInputAdoption({ canAdopt: () => false, canContinue: chatId => chatId === 'adopted' })
    expect(canAdoptInput('adopted')).toBe(false)
    expect(canContinueInstruction('adopted')).toBe(true)
    expect(canContinueInstruction('new')).toBe(false)
  })

  it('reserves only the current instruction and its leading model-only inputs before async hooks', () => {
    let open = true
    configureInputAdoption({ canAdopt: () => open })
    const entries: UserInputEntry[] = [
      { content: 'instruction', time: 0, ephemeral: true },
      { content: 'first', inputId: 'one', time: 0 },
      { content: 'second', inputId: 'two', time: 1 },
    ]
    reserveInputs('chat', entries)
    open = false
    expect(canAdoptInput('chat')).toBe(false)
    expect(isReservedInput('chat', entries[0]!)).toBe(true)
    expect(isReservedInputId('one')).toBe(true)
    expect(isReservedInputId('two')).toBe(false)
    releaseReservedInputs('chat')
    expect(isReservedInputId('one')).toBe(false)
  })
})
