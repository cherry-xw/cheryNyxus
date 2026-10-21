// Existing bash RPCs are views of the unified command owner, not a second registry.
import { listHostCommands, stopHostCommandForChat } from '@/service/hostCommands.js'

export interface BashProcessEntry {
  pid: number
  command: string
  description: string
  startedAt: number
  killed: boolean
}

export function getBashProcessActivity(): Array<BashProcessEntry & { chatId: string }> {
  return listHostCommands()
}

export function killBashProcess(chatId: string, pid: number): boolean { return stopHostCommandForChat(chatId, pid) }
export function listBashProcesses(chatId: string): BashProcessEntry[] { return listHostCommands(chatId) }
