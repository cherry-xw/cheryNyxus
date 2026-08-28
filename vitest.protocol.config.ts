import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/protocol-completeness/**/*.test.ts'],
    exclude: ['test/protocol-completeness/web/**', 'node_modules', 'dist'],
    globalSetup: ['test/protocol-completeness/globalSetup.ts'],
    setupFiles: ['test/protocol-completeness/setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['verbose'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'html'],
      reportsDirectory: 'coverage/protocol-completeness',
      include: [
        'packages/protocol/src/**',
        'src/service/message/**',
        'src/agent/provider/mock.ts',
        'src/agent/middleware/retry.ts',
      ],
      exclude: ['test/**', '**/*.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@test': resolve(__dirname, './test'),
      '@chery/protocol': resolve(__dirname, './packages/protocol/src'),
    },
  },
})
