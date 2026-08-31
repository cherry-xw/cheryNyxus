import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUN_DIR_ENV = 'CHERY_TEST_RUN_DIR'

export function setup(): () => void {
  const previous = process.env[RUN_DIR_ENV]
  const runDir = mkdtempSync(join(tmpdir(), 'chery-tests-'))
  process.env[RUN_DIR_ENV] = runDir

  return () => {
    rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    if (previous === undefined) delete process.env[RUN_DIR_ENV]
    else process.env[RUN_DIR_ENV] = previous
  }
}
