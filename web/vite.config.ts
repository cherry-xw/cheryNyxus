import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'

// ELECTRON_ENABLED=false → 纯浏览器开发（跳过 electron 构建/启动，无 X server 环境可用）
const electronEnabled = process.env.ELECTRON_ENABLED !== 'false'

export default defineConfig({
  plugins: [
    vue(),
    electronEnabled &&
      electron({
        main: {
          entry: 'electron/main.ts',
        },
        preload: { input: 'electron/preload.ts' },
        renderer: {},
      }),
  ].filter(Boolean),
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // /api 代理到后端 HTTP 服务（:8183），供 fetch('/api/config') 拿 wsPort + transport
    proxy: {
      '/api': {
        target: 'http://localhost:8183',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
})
