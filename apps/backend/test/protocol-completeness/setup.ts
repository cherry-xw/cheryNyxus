import { cpSync, mkdtempSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesDir = resolve(here, 'fixtures')
const runDir = process.env.CHERY_PROTOCOL_RUN_DIR

if (!runDir) {
  throw new Error(
    'CHERY_PROTOCOL_RUN_DIR is missing; run protocol tests with vitest.protocol.config.ts',
  )
}

const testDir = mkdtempSync(join(runDir, 'case-'))

// setupFiles runs once per test file. Use a unique fixture copy so parallel
// files can never rebuild a reusable worker directory underneath each other.
cpSync(fixturesDir, testDir, { recursive: true })

// These values must be installed before any config-dependent production
// module is imported by a test file.
process.env.CHERY_DIR = testDir
process.env.CHERY_MOCK_STRICT = 'true'
process.env.CHERY_TRANSPORT = 'binary'
