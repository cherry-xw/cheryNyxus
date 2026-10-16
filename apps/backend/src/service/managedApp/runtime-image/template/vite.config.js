import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  base: process.env.APP_BASE || './',
  cacheDir: '/tmp/vite-cache',
  plugins: [vue()],
  resolve: {
    preserveSymlinks: false,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
})
