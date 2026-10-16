import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
let child
let stopping = false
const stop = signal => { stopping = true; child?.kill(signal) }
process.once('SIGTERM', () => stop('SIGTERM'))
process.once('SIGINT', () => stop('SIGINT'))

function run(command, args) {
  if (stopping) return Promise.resolve(0)
  return new Promise((resolve, reject) => {
    child = spawn(command, args, { cwd: root, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1))
  })
}

try {
  if (process.argv[2] === '--run') {
    const built = await run(pnpm, ['exec', 'vite', 'build', '--config', 'apps/backend/vite.config.ts', '--ssr', '--mode', 'dev'])
    process.exitCode = built || await run(process.execPath, [path.join(root, 'apps/backend/dist/index.js')])
  } else {
    const entry = JSON.stringify(fileURLToPath(import.meta.url))
    process.exitCode = await run(pnpm, ['exec', 'nodemon', '--signal', 'SIGTERM', '--watch', 'apps/backend/src', '--watch', 'scripts/lib/backend-layout.mjs', '--ext', 'ts,mjs', '--exec', `${JSON.stringify(process.execPath)} ${entry} --run`])
  }
} catch {
  process.stderr.write('Backend 开发进程启动失败。\n')
  process.exitCode = 1
}
