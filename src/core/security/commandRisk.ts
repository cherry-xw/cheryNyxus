import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parse as parseBash } from 'unbash'
import type { CommandRiskCategory } from '@/utils/config.js'

export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'
export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown'

export interface SecurityFinding {
  code: string
  category: CommandRiskCategory
  severity: RiskLevel
  message: string
  fragment?: string
  start?: number
  end?: number
}

export interface CommandRiskAssessment {
  kind: 'command'
  shell: 'bash' | 'powershell'
  level: RiskLevel
  decision: 'allow' | 'approval-required'
  requiredMode: SandboxMode
  findings: SecurityFinding[]
  assessmentHash: string
}

type ParsedCommand = { name?: string; text: string; start?: number; end?: number; dynamic?: boolean }

const READ_ONLY = new Set([
  'cat', 'cd', 'echo', 'find', 'git', 'grep', 'head', 'ls', 'pwd', 'rg', 'sed', 'sort', 'tail',
  'test', 'true', 'type', 'uname', 'uniq', 'wc', 'where', 'which',
  'get-childitem', 'get-content', 'get-command', 'get-date', 'get-item', 'get-location',
  'get-process', 'get-service', 'measure-object', 'select-object', 'where-object',
])
const WORKSPACE_DEV = new Set([
  'cargo', 'dotnet', 'go', 'node', 'npm', 'npx', 'pnpm', 'python', 'python3', 'tsc', 'vitest',
  'yarn', 'copy-item', 'move-item', 'new-item', 'set-content', 'add-content', 'out-file',
])
const FILE_MUTATORS = new Set([
  'cp', 'install', 'mkdir', 'mv', 'touch', 'truncate', 'copy-item', 'move-item', 'new-item',
  'set-content', 'add-content', 'out-file', 'rename-item', 'copy', 'move', 'ren',
])
const DESTRUCTIVE = new Set([
  'dd', 'mkfs', 'rm', 'rmdir', 'shred', 'remove-item', 'clear-content', 'format-volume',
  'del', 'erase', 'rd', 'ri',
  'clear-disk', 'initialize-disk',
])
const SYSTEM = new Set([
  'reboot', 'shutdown', 'poweroff', 'stop-computer', 'restart-computer', 'stop-process', 'kill',
  'stop-service', 'restart-service', 'new-service', 'remove-service', 'sc.exe', 'reg.exe',
  'set-acl', 'takeown.exe', 'icacls.exe',
])
const NETWORK = new Set([
  'curl', 'wget', 'ssh', 'scp', 'ftp', 'invoke-webrequest', 'invoke-restmethod', 'start-bitstransfer',
])
const DYNAMIC = new Set(['eval', 'source', '.', 'invoke-expression', 'iex', 'add-type'])
const PACKAGE_INSTALL_RE = /\b(?:npm|pnpm|yarn)\s+(?:add|install|dlx)|\bnpx\b/i

function normalizeName(name?: string): string | undefined {
  return name?.trim().toLowerCase()
}

function bashCommands(source: string): { commands: ParsedCommand[]; errors: string[] } {
  let root: Record<string, unknown>
  try {
    root = parseBash(source) as unknown as Record<string, unknown>
  } catch (error) {
    return { commands: [], errors: [(error as Error).message] }
  }
  const commands: ParsedCommand[] = []
  const errors: string[] = []
  const seen = new Set<unknown>()
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object' || seen.has(node)) return
    seen.add(node)
    const value = node as Record<string, unknown>
    if (Array.isArray(value.errors)) {
      for (const error of value.errors) errors.push(String((error as { message?: unknown })?.message ?? error))
    }
    if (value.type === 'Command') {
      const word = value.name as { text?: string; pos?: number; end?: number } | undefined
      const pos = typeof value.pos === 'number' ? value.pos : word?.pos
      const end = typeof value.end === 'number' ? value.end : word?.end
      commands.push({
        name: word?.text,
        text: typeof pos === 'number' && typeof end === 'number' ? source.slice(pos, end) : word?.text ?? '',
        start: pos,
        end,
        dynamic: !word?.text || /[$`]/.test(word.text),
      })
    }
    // unbash 的 Word.parts 是 lazy getter，Object.keys 不会枚举，必须显式访问。
    if ('text' in value && 'parts' in value) visit(value.parts)
    for (const key of Object.keys(value)) visit(value[key])
  }
  visit(root)
  return { commands, errors }
}

const POWERSHELL_PARSER = String.raw`
$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:CHERY_SCRIPT_B64))
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$errors)
$commands = @($ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.CommandAst] }, $true) | ForEach-Object {
  [pscustomobject]@{
    name = $_.GetCommandName()
    text = $_.Extent.Text
    start = $_.Extent.StartOffset
    end = $_.Extent.EndOffset
    dynamic = ($null -eq $_.GetCommandName())
  }
})
[pscustomobject]@{
  commands = $commands
  errors = @($errors | ForEach-Object { $_.Message })
} | ConvertTo-Json -Depth 6 -Compress
`

let cachedPowerShellExecutable: { command: string; args: string[] } | null | undefined
function powershellExecutable(): { command: string; args: string[] } | undefined {
  if (cachedPowerShellExecutable !== undefined) return cachedPowerShellExecutable ?? undefined
  const pwsh = spawnSync('pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$null'], {
    stdio: 'ignore', timeout: 3000, windowsHide: true,
  })
  if (!pwsh.error && pwsh.status === 0) {
    cachedPowerShellExecutable = { command: 'pwsh', args: ['-NoLogo', '-NoProfile', '-NonInteractive'] }
    return cachedPowerShellExecutable
  }
  if (process.platform === 'win32') {
    const system = process.env.SystemRoot
    const legacy = system
      ? `${system}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
      : undefined
    if (legacy && existsSync(legacy)) {
      cachedPowerShellExecutable = { command: legacy, args: ['-NoLogo', '-NoProfile', '-NonInteractive'] }
      return cachedPowerShellExecutable
    }
  }
  cachedPowerShellExecutable = null
  return undefined
}

function powershellCommands(source: string): { commands: ParsedCommand[]; errors: string[] } {
  const executable = powershellExecutable()
  if (!executable) return { commands: [], errors: ['PowerShell parser unavailable'] }
  const encoded = Buffer.from(POWERSHELL_PARSER, 'utf16le').toString('base64')
  const result = spawnSync(executable.command, [...executable.args, '-EncodedCommand', encoded], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, CHERY_SCRIPT_B64: Buffer.from(source, 'utf8').toString('base64') },
  })
  if (result.error) return { commands: [], errors: [result.error.message] }
  const jsonLine = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('{'))
  if (!jsonLine) return { commands: [], errors: [result.stderr.trim() || 'PowerShell parser returned no AST'] }
  try {
    const parsed = JSON.parse(jsonLine) as { commands?: ParsedCommand | ParsedCommand[]; errors?: string[] }
    return {
      commands: Array.isArray(parsed.commands)
        ? parsed.commands
        : parsed.commands
          ? [parsed.commands]
          : [],
      errors: Array.isArray(parsed.errors) ? parsed.errors : [],
    }
  } catch (error) {
    return { commands: [], errors: [(error as Error).message] }
  }
}

const MODE_RANK: Record<SandboxMode, number> = {
  'read-only': 0,
  'workspace-write': 1,
  'danger-full-access': 2,
}
const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, unknown: 3 }

export function assessCommandRisk(
  shell: 'bash' | 'powershell',
  command: string,
  workspace?: string,
): CommandRiskAssessment {
  const parsed = shell === 'bash' ? bashCommands(command) : powershellCommands(command)
  const findings: SecurityFinding[] = []
  let requiredMode: SandboxMode = 'read-only'
  let level: RiskLevel = 'low'
  const add = (finding: SecurityFinding, mode: SandboxMode): void => {
    findings.push(finding)
    if (MODE_RANK[mode] > MODE_RANK[requiredMode]) requiredMode = mode
    if (LEVEL_RANK[finding.severity] > LEVEL_RANK[level]) level = finding.severity
  }
  for (const message of parsed.errors) {
    add({ code: 'shell.parse-error', category: 'unknown', severity: 'unknown', message }, 'danger-full-access')
  }
  for (const entry of parsed.commands) {
    const name = normalizeName(entry.name)
    const base = { fragment: entry.text, start: entry.start, end: entry.end }
    if (entry.dynamic || !name) {
      add({ ...base, code: 'shell.dynamic-command', category: 'dynamic-code', severity: 'unknown', message: '命令名在运行时动态生成，无法证明安全' }, 'danger-full-access')
      continue
    }
    if (DYNAMIC.has(name)) add({ ...base, code: 'shell.dynamic-code', category: 'dynamic-code', severity: 'high', message: `${entry.name} 会动态解释或编译代码` }, 'danger-full-access')
    else if (SYSTEM.has(name)) add({ ...base, code: 'shell.system-change', category: 'system', severity: 'high', message: `${entry.name} 会修改系统、服务或进程状态` }, 'danger-full-access')
    else if (DESTRUCTIVE.has(name)) add({ ...base, code: 'shell.destructive', category: 'destructive', severity: 'high', message: `${entry.name} 可能删除或破坏数据` }, 'workspace-write')
    else if (NETWORK.has(name)) add({ ...base, code: 'shell.network', category: 'network', severity: 'high', message: `${entry.name} 会访问网络或传输数据` }, 'workspace-write')
    else if (FILE_MUTATORS.has(name) || WORKSPACE_DEV.has(name)) add({ ...base, code: 'shell.workspace-write', category: 'filesystem', severity: 'medium', message: `${entry.name} 可能修改工作区` }, 'workspace-write')
    else if (!READ_ONLY.has(name)) add({ ...base, code: 'shell.unknown-command', category: 'unknown', severity: 'unknown', message: `未知可执行文件 ${entry.name}，无法证明安全` }, 'danger-full-access')
  }
  if (/\b(?:sudo|runas)\b/i.test(command)) add({ code: 'shell.privilege', category: 'privilege', severity: 'high', message: '命令请求提升权限', fragment: command }, 'danger-full-access')
  if (/\b(?:-encodedcommand|frombase64string)\b/i.test(command)) add({ code: 'shell.obfuscation', category: 'obfuscation', severity: 'high', message: '命令包含编码或混淆执行', fragment: command }, 'danger-full-access')
  if (/\b(?:\.env|id_rsa|id_ed25519|credentials|private[_-]?key)\b/i.test(command)) add({ code: 'shell.credential', category: 'credential', severity: 'high', message: '命令可能访问凭据或私钥', fragment: command }, 'read-only')
  if (/\b(?:curl|wget|invoke-webrequest|invoke-restmethod)\b[\s\S]*[|;]\s*(?:sh|bash|iex|invoke-expression)\b/i.test(command)) add({ code: 'shell.download-execute', category: 'dynamic-code', severity: 'high', message: '命令下载远程内容后直接执行', fragment: command }, 'danger-full-access')
  if (PACKAGE_INSTALL_RE.test(command)) add({ code: 'shell.package-install', category: 'network', severity: 'high', message: '依赖安装会访问网络并可能执行安装脚本', fragment: command }, 'workspace-write')
  if (/\bgit\s+(?:add|am|apply|checkout|cherry-pick|clean|commit|merge|mv|pull|rebase|reset|restore|rm|stash|switch)\b/i.test(command)) {
    add({ code: 'shell.git-write', category: 'filesystem', severity: 'medium', message: 'Git 子命令可能修改工作区或仓库状态', fragment: command }, 'workspace-write')
  }
  if (/(^|[^>])>{1,2}(?!>)/m.test(command)) {
    add({ code: 'shell.redirection-write', category: 'filesystem', severity: 'medium', message: '输出重定向会写入文件', fragment: command }, 'workspace-write')
  }
  if (parsed.commands.length === 0 && parsed.errors.length === 0) add({ code: 'shell.empty-ast', category: 'unknown', severity: 'unknown', message: '没有解析到可验证的命令节点' }, 'danger-full-access')

  const decision = level === 'low' || level === 'medium'
    ? 'allow'
    : 'approval-required'
  const assessmentHash = createHash('sha256')
    .update(JSON.stringify({ version: 1, shell, command, workspace: workspace ?? '', level, requiredMode, findings }))
    .digest('hex')
  return { kind: 'command', shell, level, decision, requiredMode, findings, assessmentHash }
}

export function sandboxModeRank(mode: SandboxMode): number {
  return MODE_RANK[mode]
}
