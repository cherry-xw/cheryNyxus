import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const PROTOCOL_RUN_DIR_ENV = 'CHERY_PROTOCOL_RUN_DIR'

export function setup(): () => void {
  const previousRunDir = process.env[PROTOCOL_RUN_DIR_ENV]
  const runDir = mkdtempSync(join(tmpdir(), 'chery-protocol-'))

  process.env[PROTOCOL_RUN_DIR_ENV] = runDir

  return () => {
    rmSync(runDir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 100,
    })

    if (previousRunDir === undefined) {
      delete process.env[PROTOCOL_RUN_DIR_ENV]
    } else {
      process.env[PROTOCOL_RUN_DIR_ENV] = previousRunDir
    }
  }
}
