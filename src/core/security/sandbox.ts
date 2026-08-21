import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import type { SandboxMode } from './commandRisk.js'

export interface SandboxedCommand {
  executable: string
  args: string[]
  cwd: string
  mode: SandboxMode
}

export interface SandboxedProcess {
  process: ChildProcessWithoutNullStreams
  cleanup(): void
}

function canonicalExistingDirectory(path: string): string {
  const absolute = resolve(path)
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new Error(`安全执行需要存在的工作目录：${absolute}`)
  }
  return realpathSync.native(absolute)
}

function assertInside(root: string, candidate: string): string {
  const resolved = canonicalExistingDirectory(candidate)
  const rel = relative(root, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`工作目录越出会话工作区：${candidate}`)
  }
  return resolved
}

function available(command: string, args: string[]): boolean {
  const probe = spawnSync(command, args, { stdio: 'ignore', timeout: 3000, windowsHide: true })
  return !probe.error && probe.status === 0
}

function windowsPlan(spec: SandboxedCommand): { command: string; args: string[]; cleanup: () => void } {
  const require = createRequire(import.meta.url)
  const runner = require.resolve('@deepseek-ai/dsh-sandbox-windows-acl/runner')
  const privateTemp = mkdtempSync(join(tmpdir(), 'chery-sandbox-'))
  // Windows ACL 后端只有两个受限模式。danger-full-access 仍落在 workspace-write，
  // 即用户批准高风险语义也不会获得工作区外写权限。
  const aclMode = spec.mode === 'read-only' ? 'read-only' : 'workspace-write'
  return {
    command: process.execPath,
    args: [
      runner,
      '--workspace', spec.cwd,
      '--temp', privateTemp,
      '--mode', aclMode,
      '--', spec.executable, ...spec.args,
    ],
    cleanup: () => {
      if (!existsSync(privateTemp)) return
      const base = realpathSync.native(tmpdir())
      const target = realpathSync.native(privateTemp)
      const rel = relative(base, target)
      if (!rel.startsWith('..') && !isAbsolute(rel)) rmSync(target, { recursive: true, force: true })
    },
  }
}

function linuxPlan(spec: SandboxedCommand): { command: string; args: string[]; cleanup: () => void } {
  if (!available('bwrap', ['--version'])) {
    throw new Error('SANDBOX_UNAVAILABLE: Linux 需要 bubblewrap (bwrap)，拒绝退回裸命令执行')
  }
  const rootMount = spec.mode === 'danger-full-access' ? ['--bind', '/', '/'] : ['--ro-bind', '/', '/']
  const writeMount = spec.mode === 'workspace-write' ? ['--bind', spec.cwd, spec.cwd] : []
  return {
    command: 'bwrap',
    args: [
      '--die-with-parent', '--new-session', '--unshare-all',
      ...rootMount, '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      ...writeMount, '--chdir', spec.cwd, '--', spec.executable, ...spec.args,
    ],
    cleanup: () => {},
  }
}

function escapeSeatbelt(path: string): string {
  return path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')
}

function macosPlan(spec: SandboxedCommand): { command: string; args: string[]; cleanup: () => void } {
  if (!existsSync('/usr/bin/sandbox-exec')) {
    throw new Error('SANDBOX_UNAVAILABLE: macOS sandbox-exec 不可用，拒绝退回裸命令执行')
  }
  const writes = spec.mode === 'read-only'
    ? ''
    : spec.mode === 'workspace-write'
      ? `(allow file-write* (subpath "${escapeSeatbelt(spec.cwd)}"))`
      : '(allow file-write*)'
  const profile = `(version 1)(deny default)(allow process*)(allow sysctl-read)(allow file-read*)${writes}`
  return {
    command: '/usr/bin/sandbox-exec',
    args: ['-p', profile, spec.executable, ...spec.args],
    cleanup: () => {},
  }
}

/**
 * 在当前平台的 OS 沙箱中按精确 argv 启动进程。任何探测、初始化或 spawn 失败都向上抛出；
 * 本函数没有不受限 fallback。
 */
export function spawnSandboxedCommand(
  input: SandboxedCommand & { workspaceRoot: string },
): SandboxedProcess {
  const workspace = canonicalExistingDirectory(input.workspaceRoot)
  const cwd = assertInside(workspace, input.cwd)
  const spec = { ...input, cwd }
  const plan = process.platform === 'win32'
    ? windowsPlan(spec)
    : process.platform === 'linux'
      ? linuxPlan(spec)
      : process.platform === 'darwin'
        ? macosPlan(spec)
        : (() => { throw new Error(`SANDBOX_UNAVAILABLE: 不支持的平台 ${process.platform}`) })()
  try {
    const child = spawn(plan.command, plan.args, {
      cwd,
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.stdin.end()
    let cleaned = false
    return {
      process: child,
      cleanup: () => {
        if (cleaned) return
        cleaned = true
        plan.cleanup()
      },
    }
  } catch (error) {
    plan.cleanup()
    throw error
  }
}

export function resolveWorkdir(workspaceRoot: string, workdir?: string): string {
  const workspace = canonicalExistingDirectory(workspaceRoot)
  return assertInside(workspace, workdir ? resolve(workspace, workdir) : workspace)
}

let cachedPowerShell: { executable: string; args: string[] } | null | undefined
export function resolveShellExecutable(shell: 'bash' | 'powershell'): { executable: string; args: string[] } {
  if (shell === 'bash') return { executable: 'bash', args: ['-lc'] }
  if (cachedPowerShell !== undefined) {
    if (cachedPowerShell) return cachedPowerShell
    throw new Error('SANDBOX_UNAVAILABLE: 未找到 pwsh 或 Windows PowerShell')
  }
  if (process.platform !== 'win32' || available('pwsh', ['-NoLogo', '-NoProfile', '-Command', '$null'])) {
    cachedPowerShell = { executable: 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] }
    return cachedPowerShell
  }
  const systemRoot = process.env.SystemRoot
  const legacy = systemRoot ? join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : ''
  if (legacy && existsSync(legacy)) {
    cachedPowerShell = { executable: legacy, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'] }
    return cachedPowerShell
  }
  cachedPowerShell = null
  throw new Error('SANDBOX_UNAVAILABLE: 未找到 pwsh 或 Windows PowerShell')
}
