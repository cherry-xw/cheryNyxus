#!/usr/bin/env node
// electron:dev 跨平台 wrapper。
// - Windows：无 X server，直接启动 vite——vite-plugin-electron 自动编译 electron/main.ts 并拉起 electron 窗口。
// - Linux/macOS（xrdp）：转发 electron-dev.sh（选最新可用 xrdp display + 清 ELECTRON_RUN_AS_NODE + 设 XAUTHORITY）。
import { spawn } from 'node:child_process'

const isWin = process.platform === 'win32'

/** 转发子进程退出码并保持交互（stdio inherit）；spawn 失败时以非零码退出。 */
function forward(child, label) {
  child.on('error', (err) => {
    console.error(`[electron:dev] 启动 ${label} 失败:`, err)
    process.exit(1)
  })
  child.on('exit', (code) => process.exit(code ?? 0))
}

if (isWin) {
  // 清除 agent shell 注入的 ELECTRON_RUN_AS_NODE，避免 electron 当 node 跑不开窗
  delete process.env.ELECTRON_RUN_AS_NODE
  process.env.ELECTRON_ENABLED = 'true'
  const child = spawn('vite', [], { stdio: 'inherit', shell: true })
  forward(child, 'vite')
} else {
  // 非 Windows：X11 环境选 display（原有逻辑）
  const child = spawn('bash', ['scripts/electron-dev.sh'], { stdio: 'inherit' })
  forward(child, 'electron-dev.sh')
}
