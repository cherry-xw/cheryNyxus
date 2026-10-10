import { existsSync } from 'node:fs'

/** Explicit deployment setting; never auto-enable direct execution. */
export function directContainerExecution(): boolean {
  const mode = process.env.CHERY_COMMAND_DIRECT ?? '0'
  if (mode !== '0' && mode !== '1') throw new Error('CHERY_COMMAND_DIRECT 必须为 0 或 1')
  if (mode === '0') return false
  if (!existsSync('/.dockerenv') && !existsSync('/run/.containerenv')) {
    throw new Error('CHERY_COMMAND_DIRECT=1 仅允许在容器中使用')
  }
  return true
}
