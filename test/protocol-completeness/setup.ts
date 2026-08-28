import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = resolve(here, 'fixtures')
const runDir = process.env.CHERY_PROTOCOL_RUN_DIR

if (!runDir) {
  throw new Error(
    'CHERY_PROTOCOL_RUN_DIR is missing; run protocol tests with vitest.protocol.config.ts',
  )
}

const sanitizeKeyPart = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '_')
const poolId = sanitizeKeyPart(process.env.VITEST_POOL_ID ?? 'pool')
const workerId = sanitizeKeyPart(process.env.VITEST_WORKER_ID ?? String(process.pid))
const workerDir = resolve(runDir, `worker-${poolId}-${workerId}`)

// setupFiles runs once per test file. Rebuild this worker's private fixture
// copy before production modules read and cache CHERY_DIR.
if (existsSync(workerDir)) rmSync(workerDir, { recursive: true, force: true })
cpSync(fixturesDir, workerDir, { recursive: true })

// These values must be installed before any config-dependent production
// module is imported by a test file.
process.env.CHERY_DIR = workerDir
process.env.CHERY_MOCK_STRICT = 'true'
process.env.CHERY_TRANSPORT = 'binary'

const dbDir = resolve(workerDir, '.chery', 'db')
if (existsSync(dbDir)) rmSync(dbDir, { recursive: true, force: true })
