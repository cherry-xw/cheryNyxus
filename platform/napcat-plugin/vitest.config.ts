import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
export default defineConfig({ test: { root: fileURLToPath(new URL('.', import.meta.url)), include: ['test/**/*.test.ts'], testTimeout: 10000 } })
