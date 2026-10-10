import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig(({ isSsrBuild }) => ({
  root: resolve(import.meta.dirname, 'ui'),
  plugins: [vue()],
  envDir: false,
  build: {
    outDir: resolve(import.meta.dirname, isSsrBuild ? 'server-dist' : 'dist/ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: isSsrBuild ? resolve(import.meta.dirname, 'src/index.ts') : resolve(import.meta.dirname, 'ui/index.html'),
      output: { entryFileNames: isSsrBuild ? 'index.js' : 'assets/manager.js', codeSplitting: false },
    },
  },
}))
