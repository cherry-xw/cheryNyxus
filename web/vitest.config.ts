import { resolve } from 'node:path'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  root: resolve(__dirname, '..'),
  plugins: [vue()],
  test: {
    globals: true,
    environment: 'node',
    include: ['web/test/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    reporters: ['verbose'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
      '@chery/protocol': resolve(__dirname, '../packages/protocol/src'),
      pinia: resolve(__dirname, './node_modules/pinia'),
      vue: resolve(__dirname, './node_modules/vue'),
    },
  },
})
