import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@chery/protocol/relay': resolve(import.meta.dirname, '../packages/protocol/src/relay.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['relay/test/**/*.test.ts'],
    testTimeout: 10_000,
  },
})
