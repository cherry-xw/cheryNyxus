import type { UserInputEntry } from './types.js'

interface Policy {
  canAdopt(chatId: string): boolean
  canContinue?(chatId: string): boolean
  adopted?(chatId: string): void
}

let policy: Policy | undefined
const reserved = new Map<string, Set<UserInputEntry>>()

/** Installed by the worker; core does not import service or database ownership. */
export function configureInputAdoption(next: Policy | undefined): void {
  policy = next
  reserved.clear()
}

export function canAdoptInput(chatId: string): boolean { return policy?.canAdopt(chatId) ?? true }
export function canContinueInstruction(chatId: string): boolean { return policy?.canContinue?.(chatId) ?? canAdoptInput(chatId) }

/** Reserve synchronously, before request hooks yield. Stop cannot park the same input too. */
export function reserveInputs(chatId: string, inputs: readonly UserInputEntry[]): void {
  const selected = new Set<UserInputEntry>()
  let durable = false
  for (const input of inputs) {
    if (!input.ephemeral && durable) break
    selected.add(input)
    if (!input.ephemeral) durable = true
  }
  reserved.set(chatId, selected)
  policy?.adopted?.(chatId)
}

export function isReservedInput(chatId: string, input: UserInputEntry): boolean {
  return reserved.get(chatId)?.has(input) ?? false
}

export function isReservedInputId(inputId: string): boolean {
  return [...reserved.values()].some((inputs) => [...inputs].some((input) => input.inputId === inputId))
}

export function releaseReservedInputs(chatId: string): void { reserved.delete(chatId) }
