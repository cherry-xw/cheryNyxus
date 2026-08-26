import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'

// ELECTRON_ENABLED=false → 纯浏览器开发（跳过 electron 构建/启动，无 X server 环境可用）
const electronEnabled = process.env.ELECTRON_ENABLED !== 'false'

/**
 * 把 node_modules 中的依赖按职能拆到独立的 vendor chunk，便于浏览器并行加载与长期缓存。
 *
 * 返回值作为 chunk 文件名后缀；命中规则按顺序匹配，先命中先返回。
 */
function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return
  // UI：element-plus 主包与其图标
  if (id.includes('element-plus') || id.includes('@element-plus')) {
    return 'vendor-ui'
  }
  // 动画与底层 hooks
  if (id.includes('motion-v') || id.includes('@vueuse')) {
    return 'vendor-motion'
  }
  // Markdown / 代码高亮
  if (id.includes('highlight.js') || id.includes('markdown-it')) {
    return 'vendor-markdown'
  }
  // Vue 生态核心：vue / vue-router / pinia
  if (
    id.match(/[\\/]node_modules[\\/](vue|vue-router|pinia|@vue)[\\/]/) ||
    id.includes('/node_modules/@vue/')
  ) {
    return 'vendor-vue'
  }
}

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
      '@chery/protocol': fileURLToPath(new URL('../packages/protocol/src', import.meta.url)),
    },
  },
  server: {
    // 监听 0.0.0.0：支持内网跨机器访问（dev:web 从其他主机访问页面 + WS）
    host: true,
    port: 5173,
    strictPort: true,
    // fs.inotify.max_user_watches 默认 65536，被 web 的大 deps + electron plugin
    // 同时扫描耗尽，dev 报 EMFILE。改 polling 不占 inotify watcher（CPU 几乎无感）。
    watch: {
      usePolling: true,
      interval: 1000,
    },
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
    /**
     * SPA 产物路径：`<repo>/dist/web/`（与 SSR 产物 `<repo>/dist/index.js` 同级）。
     * 单次 `pnpm build`（root 触发 web 也 build）即可得到单一可分发目录，
     * 后端启动时（`server.serve_frontend=true`）直接同源 serve `/api/*` 与 SPA，无 CORS。
     *
     * 兼容：仍支持旧位置 `<repo>/web/dist/`，worker 启动时 resolveStaticDir 会按
     * "dist/web/ → web/dist/" 顺序探测，dev 用户无需清理旧产物。
     */
    outDir: '../dist/web',
    emptyOutDir: true,
    sourcemap: true,
    // 关闭 lightningcss、改用 esbuild 做 CSS 压缩：
    // lightningcss 1.32 把 Vue 3 作用域样式的 `:deep(...)` 选择器误判成无参数 pseudo-class，
    // 每个 scoped style 都会刷一条警告，污染构建日志。esbuild 对该语法静默，输出体积无可见差异。
    cssMinify: 'esbuild',
    rollupOptions: {
      // 抑制 @vueuse/core 14.3 dist 中 `/* #__PURE__ */` 注释位置错误造成的 Rolldown INVALID_ANNOTATION。
      // 上游仓库已知问题（注释被编译器重排到不识别的位置），其他来源的同一 code 仍正常上报。
      onwarn(warning, warn) {
        if (
          warning.code === 'INVALID_ANNOTATION' &&
          typeof warning.id === 'string' &&
          warning.id.includes('@vueuse/core')
        ) {
          return
        }
        warn(warning)
      },
      output: {
        manualChunks,
      },
    },
  },
})
