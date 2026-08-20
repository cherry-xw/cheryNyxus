#!/usr/bin/env node
// electron:dev 跨平台 wrapper。
// - Windows：无 X server，直接启动 vite——vite-plugin-electron 自动编译 electron/main.ts 并拉起 electron 窗口。
// - Linux/macOS（xrdp）：转发 electron-dev.sh（选最新可用 xrdp display + 清 ELECTRON_RUN_AS_NODE + 设 XAUTHORITY）。
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const isWin = process.platform === 'win32'
const webDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = resolve(webDir, '..')

/** Electron main 会直接启动 dist/index.js；先完成一次 SSR 构建，禁止沿用上次开发留下的旧 bundle。 */
function buildBackend() {
  console.log('[electron:dev] 正在构建当前后端…')
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(
      'pnpm',
      ['build'],
      { cwd: repoDir, stdio: 'inherit', shell: isWin },
    )
    child.once('error', rejectBuild)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveBuild()
      else rejectBuild(new Error(`后端构建失败（code=${code ?? 'null'}, signal=${signal ?? 'none'}）`))
    })
  })
}

/** 转发子进程退出码并保持交互（stdio inherit）；spawn 失败时以非零码退出。 */
function forward(child, label) {
  child.on('error', (err) => {
    console.error(`[electron:dev] 启动 ${label} 失败:`, err)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 0))
}

try {
  await buildBackend()
  if (isWin) {
    // 清除 agent shell 注入的 ELECTRON_RUN_AS_NODE，避免 electron 当 node 跑不开窗
    delete process.env.ELECTRON_RUN_AS_NODE
    process.env.ELECTRON_ENABLED = 'true'
    const child = spawn('vite', [], { cwd: webDir, stdio: 'inherit', shell: true })
    forward(child, 'vite')
  } else {
    // 非 Windows：X11 环境选 display（原有逻辑）
    const child = spawn('bash', ['scripts/electron-dev.sh'], { cwd: webDir, stdio: 'inherit' })
    forward(child, 'electron-dev.sh')
  }
} catch (err) {
  console.error('[electron:dev]', err)
  process.exit(1)
}
