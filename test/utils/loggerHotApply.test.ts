import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { captureRuntimeConfig } from '@/utils/config.js'
import { initLogger, logger } from '@/utils/logger/index.js'

function readLogs(logDir: string): string {
  if (!existsSync(logDir)) return ''
  return readdirSync(logDir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => readFileSync(join(logDir, name), 'utf8'))
    .join('\n')
}

async function waitForLog(logDir: string, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (readLogs(logDir).includes(message)) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`Timed out waiting for log message: ${message}`)
}

afterEach(() => {
  initLogger(captureRuntimeConfig().global.logger)
})

describe('logger hot apply', () => {
  it('stops writing to the file after file output is disabled', async () => {
    const before = `logger-before-${Date.now()}`
    const after = `logger-after-${Date.now()}`
    const logDir = join(process.env.CHERY_DIR || process.cwd(), '.chery', 'logs')
    initLogger({ output: ['file'], location: false, timestamp: false })
    logger.info(before)
    await waitForLog(logDir, before)
    logger.setConfig({ output: [] })
    logger.info(after)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(existsSync(logDir)).toBe(true)
    const content = readLogs(logDir)
    expect(content).toContain(before)
    expect(content).not.toContain(after)
  })
})
