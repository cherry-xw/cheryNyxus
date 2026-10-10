import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
export default defineConfig({ root: resolve(import.meta.dirname, 'ui'), base: './', envDir: false, plugins: [vue()], build: { outDir: resolve(import.meta.dirname, 'ui-built'), emptyOutDir: true, rollupOptions: { input: resolve(import.meta.dirname, 'ui/index.html') } } })
