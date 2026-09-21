import { access } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const managerBaseUrl = 'http://127.0.0.1:39980'

export async function runManagerCli(argv: string[]): Promise<boolean> {
  const [command, subcommand] = argv
  if (!command) return false
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return true
  }
  if (command === 'status' || command === 'info') {
    await printEndpoint(command === 'status' ? '/api/status' : '/api/connection')
    return true
  }
  if (command === 'restart') {
    const target = subcommand === 'rathole' ? 'rathole' : 'backend'
    await callControl(`${target}/restart`)
    return true
  }
  if (command === 'service' && (subcommand === 'install' || subcommand === 'uninstall')) {
    await runServiceScript(subcommand)
    return true
  }
  throw new Error(`未知管理器命令：${argv.join(' ')}`)
}

function printHelp(): void {
  process.stdout.write(
    `CheryNyxus 本地管理器\n\n命令：\n  （无参数）           启动 127.0.0.1:39980 管理器\n  info                 显示连接发现信息\n  status               显示管理器、后端和 rathole 状态\n  restart [backend|rathole]  重启指定进程（需要 CHERY_MANAGER_TOKEN）\n  service install      安装当前平台的本地服务入口\n  service uninstall    卸载当前平台的本地服务入口\n  help                 显示帮助\n\n环境变量：\n  CHERY_MANAGER_TOKEN  管理控制密钥\n  CHERY_DIR            后端运行目录\n`,
  )
}

async function printEndpoint(path: string): Promise<void> {
  const response = await fetch(`${managerBaseUrl}${path}`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`管理器请求失败：HTTP ${response.status}`)
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`)
}

async function callControl(path: string): Promise<void> {
  const token = process.env.CHERY_MANAGER_TOKEN
  if (!token) throw new Error('restart 需要设置 CHERY_MANAGER_TOKEN')
  const response = await fetch(`${managerBaseUrl}/api/${path}`, {
    method: 'POST',
    headers: { 'X-Chery-Manager-Token': token },
  })
  if (!response.ok) throw new Error(`管理器请求失败：HTTP ${response.status}`)
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`)
}

async function runServiceScript(action: 'install' | 'uninstall'): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const script =
    process.platform === 'win32'
      ? resolve(root, 'deploy/windows/service.ps1')
      : resolve(root, 'deploy/systemd/service.sh')
  await access(script)
  const args =
    process.platform === 'win32'
      ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, `-${action}`]
      : [script, action]
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(process.platform === 'win32' ? 'powershell.exe' : 'sh', args, {
      stdio: 'inherit',
      env: { ...process.env, CHERY_MANAGER_ROOT: root },
      windowsHide: true,
    })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`服务操作失败，退出码 ${code ?? 'unknown'}`)),
    )
  })
}
