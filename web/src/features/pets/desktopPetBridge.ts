export interface DesktopPetCandidate {
  chatId: string
  label: string
  working: boolean
}

export interface DesktopPetBridge {
  publish(candidates: DesktopPetCandidate[]): void
  onState(listener: (candidate: DesktopPetCandidate | null) => void): () => void
  onOpenChat(listener: (chatId: string) => void): () => void
  openChat(chatId: string): void
  setMousePassthrough(ignore: boolean): void
}

export function desktopPetBridge(): DesktopPetBridge | undefined {
  return window.__DESKTOP_PET__
}
