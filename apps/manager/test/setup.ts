import { afterAll } from 'vitest'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Manager tests must never create accounts or machine secrets in developer data.
const root = mkdtempSync('/tmp/opencode/manager-tests-')
cpSync(new URL('../../backend/test/flows/fixtures/.chery/', import.meta.url), join(root, '.chery'), { recursive: true })
process.env.CHERY_DIR = root
process.env.CHERY_ENV_FILE = join(root, 'test.env')
process.env.DB_DIR = join(root, '.chery/db')
afterAll(() => rmSync(root, { recursive: true, force: true }))
