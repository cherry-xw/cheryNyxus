import { resolve } from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      '@chery/protocol/relay': resolve(import.meta.dirname, '../packages/protocol/src/relay.ts'),
    },
  },
  build: {
    ssr: true,
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    lib: {
      entry: resolve(import.meta.dirname, 'src/index.ts'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rollupOptions: { output: { codeSplitting: false } },
  },
  ssr: { noExternal: true },
})
