import { access, readFile } from 'node:fs/promises'
import { configureAccount } from './accountCli.js'
import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function managerBaseUrl(): string {
  const port = process.env.CHERY_MANAGER_PORT === undefined ? 39980 : Number(process.env.CHERY_MANAGER_PORT)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('CLI CHERY_MANAGER_PORT 无效')
  return `http://${managerHost()}:${port}`
}

function managerHost(): string {
  const configured = process.env.CHERY_MANAGER_HOST?.trim()
  return configured && configured !== '127.0.0.1' && configured !== 'localhost' ? configured : '10.2.3.6'
}

export async function runManagerCli(argv: string[]): Promise<boolean> {
  const [command, subcommand] = argv
  if (!command) return false
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp()
    return true
  }
  if (command === 'status' || command === 'info') {
    if (argv.length !== 1) throw new Error('状态命令不接受额外参数')
    await printEndpoint(command === 'status' ? '/api/machine/status' : '/api/machine/connection')
    return true
  }
  if (command === 'auth') {
    if (argv.length !== 2 || !['setup', 'reset'].includes(subcommand ?? '')) throw new Error('用法：auth setup 或 auth reset；禁止密码参数')
    await configureAccount(resolve(process.env.CHERY_DIR ?? process.cwd(), '.chery/manager-auth.json'), subcommand === 'reset')
    return true
  }
  if (command === 'start' || command === 'stop' || command === 'restart') {
    if (argv.length > 2 || subcommand && !['backend', 'rathole'].includes(subcommand)) throw new Error('进程命令目标只能是 backend 或 rathole')
    const target = subcommand === 'rathole' ? 'rathole' : 'backend'
    await callControl(`${target}/${command}`)
    return true
  }
  if (command === 'service' && (subcommand === 'install' || subcommand === 'uninstall')) {
    await runServiceScript(subcommand)
    return true
  }
  throw new Error('未知管理器命令，请运行 help')
}

function printHelp(): void {
  process.stdout.write(
    `CheryNyxus 局域网管理器\n\n命令：\n  （无参数）           启动局域网管理器（默认 0.0.0.0:39980）\n  auth setup           隐藏输入设置 Manager 账号\n  auth reset           隐藏输入重置账号并使旧会话失效\n  info / status        读取机器状态\n  start/stop/restart [backend|rathole]  控制指定子进程\n  service install/uninstall  安装或卸载用户级服务\n  help                 显示帮助\n\n环境变量：\n  CHERY_MANAGER_HOST   监听地址，优先于 manager.host；默认 0.0.0.0\n  CHERY_MANAGER_TOKEN  仅机器密钥；默认读取 .chery/manager-token.json\n  CHERY_DIR            后端运行目录\n\n局域网访问必须配置可信 Host/Origin；远程部署使用 HTTPS。\n`,
  )
}

async function printEndpoint(path: string): Promise<void> {
  const response = await fetch(`${managerBaseUrl()}${path}`, { cache: 'no-store', headers: { 'X-Chery-Manager-Machine-Key': await machineKey() }, signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`管理器请求失败：HTTP ${response.status}`)
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`)
}

async function callControl(path: string): Promise<void> {
  const token = await machineKey()
  const response = await fetch(`${managerBaseUrl()}/api/machine/${path}`, {
    method: 'POST',
    headers: { 'X-Chery-Manager-Machine-Key': token },
    signal: AbortSignal.timeout(10000),
  })
  if (!response.ok) throw new Error(`管理器请求失败：HTTP ${response.status}`)
  process.stdout.write(`${JSON.stringify(await response.json(), null, 2)}\n`)
}

async function machineKey(): Promise<string> {
  if (process.env.CHERY_MANAGER_TOKEN) return process.env.CHERY_MANAGER_TOKEN
  try {
    const state = JSON.parse(await readFile(resolve(process.env.CHERY_DIR ?? process.cwd(), '.chery/manager-token.json'), 'utf8')) as { token?: unknown }
    if (typeof state.token === 'string' && state.token) return state.token
  } catch { /* 不创建或打印机器密钥。 */ }
  throw new Error('机器密钥不存在，请先启动 Manager 或配置 CHERY_MANAGER_TOKEN')
}

async function runServiceScript(action: 'install' | 'uninstall'): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
  const script =
    process.platform === 'win32'
      ? resolve(root, 'apps/manager/deploy/windows/service.ps1')
      : resolve(root, 'apps/manager/deploy/systemd/service.sh')
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
