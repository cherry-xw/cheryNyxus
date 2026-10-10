import { defineConfig } from 'vite'
import { resolve } from 'node:path'
export default defineConfig({
  envDir: false,
  resolve: { alias: { '@': resolve('src'), '@chery/protocol': resolve('packages/protocol/src') } },
  build: {
    ssr: resolve('apps/backend/test/service/fixtures/qqRestartWorker.ts'),
    outDir: resolve('dist/qq-restart-fixture'),
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'worker.mjs' } },
  },
})
