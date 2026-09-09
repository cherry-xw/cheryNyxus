// Temporary archive integration verification; writes only into verify/out/.
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: { include: ['docs/plan/session-archive/verify/archive.test.ts'], testTimeout: 20000 },
  resolve: { alias: { '@': resolve('src'), '@chery/protocol': resolve('packages/protocol/src') } },
})
