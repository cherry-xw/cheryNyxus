import type { PetAction, PetMood } from './types/types'

export interface DesktopPetCandidate {
  chatId: string
  label: string
  action: PetAction
  mood: PetMood
  working: boolean
  speech: string
  activity: number
}

export interface DesktopPetBridge {
  publish(candidates: DesktopPetCandidate[]): void
  onState(listener: (candidate: DesktopPetCandidate | null) => void): () => void
  onOpenChat(listener: (chatId: string) => void): () => void
  onOpenHistory(listener: (chatId: string) => void): () => void
  openChat(chatId: string): void
  showContextMenu(chatId: string): void
  moveWindow(position: { x: number; y: number }): void
  setMousePassthrough(ignore: boolean): void
}

export function desktopPetBridge(): DesktopPetBridge | undefined {
  return window.__DESKTOP_PET__
}
