import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
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
