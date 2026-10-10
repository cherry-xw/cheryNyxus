import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadEnvFile } from '@/utils/envFile.js'

describe('env file loading', () => {
  const files: string[] = []

  afterEach(() => {
    for (const file of files.splice(0)) fs.rmSync(file, { force: true })
  })

  it('can exclude deployment-only credential handles', () => {
    const file = path.join(os.tmpdir(), `chery-env-${process.pid}-${Date.now()}.env`)
    files.push(file)
    fs.writeFileSync(file, 'QQBOT_PLATFORM_TOKEN=from-file\nAPP_MODE=test\n')
    const env: NodeJS.ProcessEnv = {}

    loadEnvFile(file, env, { excludedKeys: new Set(['QQBOT_PLATFORM_TOKEN']) })

    expect(env.QQBOT_PLATFORM_TOKEN).toBeUndefined()
    expect(env.APP_MODE).toBe('test')
  })
})
