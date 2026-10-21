import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  root: resolve(import.meta.dirname, '../..'),
  envDir: false,
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, '../backend/src'),
      '@chery/protocol': resolve(import.meta.dirname, '../../packages/protocol/src'),
    },
  },
  test: {
    setupFiles: ['apps/manager/test/setup.ts'],
    include: [
      'apps/manager/test/**/*.test.ts',
    ],
    testTimeout: 15000,
    fileParallelism: false,
  },
})
