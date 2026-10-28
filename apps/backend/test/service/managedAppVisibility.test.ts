import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ManagedAppController } from '../../src/service/managedApp/controller.ts'
import type { ManagedAppRecord } from '../../src/service/managedApp/types.ts'

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), execFile,
}))
vi.mock('../../src/service/managedApp/networkLimits.ts', () => ({
  initializeApplicationNetworkLimits: vi.fn(), limitApplicationNetwork: vi.fn(),
}))

function fixture(visibility: ManagedAppRecord['visibility']) {
  const controller = new ManagedAppController() as any
  const record = { userId: '649207438', appId: 'visibility-test', visibility,
    state: 'stopped', projectId: 10001, containerName: 'test-container', leaseExpiresAt: Date.now() + 86400000 }
  controller.store.upsertApp = vi.fn(async () => {})
  controller.requireOwnedApp = vi.fn(() => record)
  controller.inspectDockerContainer = vi.fn(async () => ({ id: 'test', ip: '172.29.0.3', running: true }))
  controller.readContainerMemoryCurrentByKey = vi.fn(async () => 1)
  return { controller, record }
}

describe('managed app visibility propagation', () => {
  beforeEach(() => {
    execFile.mockReset()
    execFile.mockImplementation((_file: string, _args: string[], ...rest: any[]) => {
      rest.at(-1)(null, { stdout: '', stderr: '' })
    })
  })

  it.each(['private', 'public_read'] as const)('injects %s when creating a new container', async visibility => {
    const { controller, record } = fixture(visibility)
    controller.quota.ensureProjectDirectoriesAndQuota = vi.fn(async () => ({ projectDir: '/test/project', dataDir: '/test/data' }))
    controller.ledger.admitNormalStart = vi.fn(async () => {})
    controller.inspectDockerContainer.mockResolvedValueOnce(null)
    await controller.ensureContainerRunningLocked(record)
    const args = execFile.mock.calls.find(call => call[1][0] === 'run')![1]
    expect(args).toContain(`APP_VISIBILITY=${visibility}`)
  })

  it.each(['private', 'public_read'] as const)('injects %s at publish even when reusing a running container', async visibility => {
    const { controller, record } = fixture(visibility)
    controller.ensureContainerRunning = vi.fn(async () => record)
    controller.waitForHealthcheck = vi.fn(async () => ({ activated: true }))
    await controller.startAppService({ userId: record.userId, appId: record.appId, buildFirst: false })
    const args = execFile.mock.calls.find(call => call[1].includes('CHERY_APP_SERVER=1'))![1]
    expect(args).toContain(`APP_VISIBILITY=${visibility}`)
    expect(args.indexOf(`APP_VISIBILITY=${visibility}`)).toBeLessThan(args.indexOf(record.containerName))
  })
})
