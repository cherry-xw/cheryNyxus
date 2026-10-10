import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('../../../../src', import.meta.url)),
      '@chery/protocol': fileURLToPath(new URL('../../../../packages/protocol/src', import.meta.url)),
    },
  },
  test: {
    include: ['apps/manager/test/modules/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 20000,
  },
})
