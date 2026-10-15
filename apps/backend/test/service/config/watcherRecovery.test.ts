import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import yaml from 'js-yaml'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let root: string
let previousRoot: string | undefined

const validConfig = (editor = 'old-editor') => `global:
  supervision: smart
  textEditor: ${editor}
llm:
  brain:
    mock:
      provider: mock
      model: mock_test
`

describe('manual config maintenance recovery', () => {
  beforeEach(() => {
    previousRoot = process.env.CHERY_DIR
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'chery-watcher-recovery-'))
    fs.mkdirSync(path.join(root, '.chery'), { recursive: true })
    fs.writeFileSync(path.join(root, '.chery', 'config.yaml'), validConfig())
    process.env.CHERY_DIR = root
    vi.resetModules()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    const db = await import('@/db/index.js')
    db.closeAllDbs()
    if (previousRoot === undefined) delete process.env.CHERY_DIR
    else process.env.CHERY_DIR = previousRoot
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('restores only accepted business fields, keeps newer foreign fields and holds maintenance', async () => {
    const { startConfigRevisionWatcher } = await import('@/service/config/watcher.js')
    const { getMaintenanceState } = await import('@/service/maintenanceMode.js')
    const filename = path.join(root, '.chery', 'config.yaml')
    const watcher = startConfigRevisionWatcher()
    try {
      // Establish a newer accepted business image, not just the startup snapshot.
      fs.writeFileSync(filename, validConfig('latest-accepted'))
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      const invalid = `${validConfig('bad-editor').replace('supervision: smart', 'supervision: invalid')}
manager:
  auth:
    username: newer-manager
server:
  auth:
    password: newer-business-hash
    machine:
      password: newer-machine-hash
relay:
  backendId: newer-device
otherEnd:
  revision: 42
roles:
  invalid:
    brain: missing
`
      fs.writeFileSync(filename, invalid)
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      const restored = yaml.load(fs.readFileSync(filename, 'utf8')) as Record<string, any>
      expect(restored.global).toEqual({ supervision: 'smart', textEditor: 'latest-accepted' })
      expect(restored.roles).toBeUndefined()
      expect(restored.manager).toEqual({ auth: { username: 'newer-manager' } })
      expect(restored.server).toEqual({ auth: { password: 'newer-business-hash', machine: { password: 'newer-machine-hash' } } })
      expect(restored.relay).toEqual({ backendId: 'newer-device' })
      expect(restored.otherEnd).toEqual({ revision: 42 })
      const backups = fs.readdirSync(path.join(root, '.chery', 'backups'))
      expect(backups).toHaveLength(1)
      expect(fs.readFileSync(path.join(root, '.chery', 'backups', backups[0]!), 'utf8')).toBe(invalid)
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(getMaintenanceState().active).toBe(true)
      fs.writeFileSync(filename, yaml.dump({ ...restored, global: { supervision: 'smart', textEditor: 'user-confirmed' } }))
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(getMaintenanceState().active).toBe(false)
    } finally { watcher.close() }
  })

  it('waits for a foreign lock instead of recovering over a concurrent writer', async () => {
    const { startConfigRevisionWatcher } = await import('@/service/config/watcher.js')
    const filename = path.join(root, '.chery', 'config.yaml')
    const watcher = startConfigRevisionWatcher()
    try {
      fs.mkdirSync(`${filename}.transaction-lock`)
      fs.writeFileSync(filename, 'global: [')
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(fs.readFileSync(filename, 'utf8')).toBe('global: [')
      expect(fs.existsSync(path.join(root, '.chery', 'backups'))).toBe(false)
      fs.writeFileSync(filename, validConfig('concurrent-repair'))
      fs.rmdirSync(`${filename}.transaction-lock`)
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(fs.readFileSync(filename, 'utf8')).toBe(validConfig('concurrent-repair'))
    } finally { watcher.close() }
  })

  it('applies a valid user repair after preserving invalid YAML', async () => {
    const { startConfigRevisionWatcher } = await import('@/service/config/watcher.js')
    const { getMaintenanceState } = await import('@/service/maintenanceMode.js')
    const { getConfigApplyCoordinator } = await import('@/service/config/commit.js')
    const { getAppliedRawConfig } = await import('@/utils/config.js')
    const filename = path.join(root, '.chery', 'config.yaml')
    const watcher = startConfigRevisionWatcher()
    try {
      fs.writeFileSync(filename, 'global: [')
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(getMaintenanceState().active).toBe(true)
      expect(fs.readFileSync(filename, 'utf8')).toBe('global: [')
      const rejected = fs.readdirSync(path.join(root, '.chery', 'backups'))[0]!
      expect(fs.readFileSync(path.join(root, '.chery', 'backups', rejected), 'utf8')).toBe('global: [')

      fs.writeFileSync(filename, validConfig('repaired-editor'))
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      await getConfigApplyCoordinator().retry()
      expect(getMaintenanceState().active).toBe(false)
      expect(getAppliedRawConfig().global.textEditor).toBe('repaired-editor')
      expect(fs.readdirSync(path.join(root, '.chery', 'backups'))).toEqual([
        expect.stringMatching(/^rejected-manual-/),
      ])
    } finally {
      watcher.close()
    }
  })
})
