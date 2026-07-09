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
    // 监听 0.0.0.0：支持内网跨机器访问（dev:web 从其他主机访问页面 + WS）
    host: true,
    port: 5173,
    strictPort: true,
    // /api → 后端 HTTP(:8183)；/ws → 后端 WebSocket(:8182)
    // WS 走 vite proxy：跨机器访问只需暴露单端口 5173，无需开放 8182
    proxy: {
      '/api': {
        target: 'http://localhost:8183',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8182',
        ws: true,
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
