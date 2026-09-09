// Isolated workflow checks. Run: pnpm exec vitest run --config docs/plan/main-agent-runtime-diagram/verify/vitest.config.ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
export default defineConfig({
  test: { environment: 'node', include: ['docs/plan/main-agent-runtime-diagram/verify/*.test.ts'] },
  resolve: {
    alias: { '@': resolve('src'), '@chery/protocol': resolve('packages/protocol/src/index.ts') },
  },
})
