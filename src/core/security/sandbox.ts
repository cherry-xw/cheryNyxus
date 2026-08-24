import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
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
  // bash 方言：非 win32 保持 bash -lc（AI 写的是 bash 语义脚本，不能用 sh 跑 bashism）；
  // win32 走 POSIX 探测链（bash 优先），解析不到由 resolvePosixShell 抛指引错误。
  if (shell === 'bash') {
    return { executable: resolvePosixShell(true).executable, args: ['-lc'] }
  }
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

// ============ POSIX shell 解析（hooks 执行器 / execute_command bash 方言共用）============

/** 解析不到 POSIX shell 时的统一指引（userMessage 直出，见 docs/agent/hooks.md 跨平台执行） */
export const POSIX_SHELL_HINT =
  '未找到可用的 POSIX shell（bash/sh）。Windows 请安装 Git for Windows（探测链会自动定位其 bash），或删除/改写对应 handler'

/** win32 探测结果缓存（bash 优先；探测链对两个调用方一致，共享缓存） */
let cachedWindowsPosixShell: { executable: string } | null | undefined

/** where <name> 的首个命中路径（win32）；失败返回 null */
function probeWhereFirst(name: string): string | null {
  const probe = spawnSync('where', [name], {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
    windowsHide: true,
    encoding: 'utf8',
  })
  if (probe.error || probe.status !== 0 || !probe.stdout) return null
  return probe.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] ?? null
}

/** git.exe 同仓向上找 usr/bin/bash.exe（Git for Windows 布局：cmd/ bin/ mingw64/bin/ 三种放置均 ≤3 级可达根） */
function findBashNearGit(gitPath: string): string | null {
  let dir = dirname(gitPath)
  for (let depth = 0; depth < 4; depth++) {
    const candidate = join(dir, 'usr', 'bin', 'bash.exe')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** 常见 Git for Windows 安装路径（where git 反查失败的兜底，如 scoop shim 场景） */
function commonGitBashPaths(): string[] {
  const localAppData = process.env.LOCALAPPDATA
  return [
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
    ...(localAppData ? [join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe')] : []),
  ]
}

/** win32 探测链：PATH bash → PATH sh → where git 反查 → 常见路径；全 miss 返回 null */
function probeWindowsPosixShell(): { executable: string } | null {
  if (cachedWindowsPosixShell !== undefined) return cachedWindowsPosixShell
  let found: { executable: string } | null = null
  if (available('bash', ['-c', 'true'])) {
    found = { executable: 'bash' }
  } else if (available('sh', ['-c', 'true'])) {
    found = { executable: 'sh' }
  } else {
    const gitPath = probeWhereFirst('git')
    const gitBash = gitPath ? findBashNearGit(gitPath) : null
    const candidate = gitBash ?? commonGitBashPaths().find((p) => existsSync(p)) ?? null
    if (candidate && available(candidate, ['-c', 'true'])) found = { executable: candidate }
  }
  cachedWindowsPosixShell = found
  return found
}

/**
 * 解析可执行 POSIX shell（hooks handler 执行器主入口）。
 * - 非 win32：bashFirst（execute_command bash 方言）→ bash；否则 sh（hooks 历史行为）
 * - win32：探测链（见 probeWindowsPosixShell）；失败抛 SHELL_UNAVAILABLE（fail-loud，
 *   message 含安装指引——平台缺失不能静默跳过安全类 handler，见 hooks.md 失败语义表）
 */
export function resolvePosixShell(bashFirst = false): { executable: string } {
  if (process.platform !== 'win32') {
    return { executable: bashFirst ? 'bash' : 'sh' }
  }
  const found = probeWindowsPosixShell()
  if (found) return found
  throw new Error(`SHELL_UNAVAILABLE: ${POSIX_SHELL_HINT}`)
}

/** hooks.get 展示用（不抛版）：available=false 时返回安装指引 */
export function describePosixShell(): { available: true; executable: string } | { available: false; hint: string } {
  try {
    return { available: true, executable: resolvePosixShell().executable }
  } catch {
    return { available: false, hint: POSIX_SHELL_HINT }
  }
}

/** 测试用：清空 win32 探测缓存 */
export function resetPosixShellCache(): void {
  cachedWindowsPosixShell = undefined
}
