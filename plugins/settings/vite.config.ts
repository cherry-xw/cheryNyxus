import { defineConfig } from 'vite'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'
export default defineConfig({
  build: {
    target: 'node20', minify: false,
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    lib: { entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)), formats: ['es'], fileName: () => 'index.mjs' },
    rolldownOptions: { platform: 'node', external: [...builtinModules, ...builtinModules.map(m => `node:${m}`)] },
  },
})
