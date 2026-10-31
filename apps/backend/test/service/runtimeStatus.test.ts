import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { BackendStatusSchema, BACKEND_STATUS_INTERVAL_MS } from '@chery/protocol'
import { writeBackendStatusFile } from '../../src/service/runtimeStatus.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
it('publishes strict complete observations with actual interval and no temporary leftovers', () => {
  const root = mkdtempSync(join(tmpdir(), 'backend-status-writer-')); roots.push(root)
  const file = join(root, 'status.json'), now = Date.now()
  const data = { file, instanceId: 'i'.repeat(32), addresses: { local: { httpPort: 8183, websocketPort: 8182 } }, agents: { initializedChats: 1, runningChats: 1, activeRuns: 1 }, now }
  writeBackendStatusFile(data)
  expect(BackendStatusSchema.parse(JSON.parse(readFileSync(file, 'utf8')))).toMatchObject({ protocolVersion: 2, heartbeatIntervalMs: BACKEND_STATUS_INTERVAL_MS, updatedAt: new Date(now).toISOString() })
  expect(readdirSync(root)).toEqual(['status.json'])
  if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
  const before = readFileSync(file, 'utf8')
  expect(() => writeBackendStatusFile({ ...data, agents: { secret: 'invalid' } })).toThrow()
  expect(readFileSync(file, 'utf8')).toBe(before)
})
