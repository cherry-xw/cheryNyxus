import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { SupervisionLevel } from '@/core/config.js'
import type {
  RoleConfig,
  RolePermissionEffect,
  RolePermissionPolicy,
  RolePermissionTemplate,
} from '@/utils/config.js'
import { assessCommandRisk, sandboxModeRank, type SandboxMode, type SecurityFinding } from './commandRisk.js'

export interface CompiledRoleSecurity {
  roleType: string
  policy: RolePermissionPolicy
  policyHash: string
}

export interface ToolAuthorization {
  decision: 'allow' | 'ask' | 'deny'
  roleType: string
  policyHash: string
  requiredSandboxMode?: SandboxMode
  findings: SecurityFinding[]
  assessmentHash: string
}

/**
 * 进程内角色验收的不可放宽安全覆盖层。
 *
 * 它与角色自身权限求交：只能继续收紧，不能把角色策略的 deny 改为 allow。
 */
export interface AcceptanceExecutionPolicy {
  workspaceRoot: string
  allowedTools: readonly string[]
  maxCommandSandboxMode: 'read-only' | 'workspace-write'
  preapproveSafeRequests: true
}

const ACCEPTANCE_DENIED_COMMAND_CATEGORIES = new Set([
  'destructive',
  'privilege',
  'system',
  'process',
  'network',
  'credential',
  'dynamic-code',
  'obfuscation',
  'unknown',
])

const MUTATING_TOOLS = new Set([
  'write_file', 'memory_manage', 'install_skill', 'generate_image', 'generate_video',
  'generate_audio', 'destroy_role',
])
const HARMLESS_TOOLS = new Set([
  'read_file', 'search_codebase', 'history_recall', 'ask_user_question', 'update_todo',
  'select_conversation', 'send_to_child', 'stop_child', 'role_acceptance',
])

function defaultPolicy(template: RolePermissionTemplate): RolePermissionPolicy {
  switch (template) {
    case 'read-only':
      return {
        template,
        filesystem: { read: 'workspace', write: 'deny' },
        commands: { shells: ['bash', 'powershell'], maxSandboxMode: 'read-only' },
        mcp: { default: 'deny' },
        spawn: { effect: 'deny' },
      }
    case 'workspace-developer':
      return {
        template,
        filesystem: { read: 'workspace', write: 'workspace' },
        commands: { shells: ['bash', 'powershell'], maxSandboxMode: 'workspace-write' },
        mcp: { default: 'ask' },
        spawn: { effect: 'inherit' },
      }
    case 'trusted':
      return {
        template,
        filesystem: { read: 'any', write: 'any-with-approval' },
        commands: { shells: ['bash', 'powershell'], maxSandboxMode: 'danger-full-access' },
        mcp: { default: 'inherit' },
        spawn: { effect: 'inherit' },
      }
    case 'supervised':
    default:
      return {
        template: 'supervised',
        filesystem: { read: 'workspace', write: 'any-with-approval' },
        commands: { shells: ['bash', 'powershell'], maxSandboxMode: 'danger-full-access' },
        mcp: { default: 'ask' },
        spawn: { effect: 'ask' },
      }
  }
}

function mergePolicy(policy?: RolePermissionPolicy): RolePermissionPolicy {
  const chosen = policy?.template ?? 'supervised'
  const base = defaultPolicy(chosen)
  return {
    ...base,
    ...policy,
    filesystem: { ...base.filesystem, ...policy?.filesystem },
    commands: {
      ...base.commands,
      ...policy?.commands,
      categories: { ...base.commands?.categories, ...policy?.commands?.categories },
    },
    mcp: { ...base.mcp, ...policy?.mcp, tools: { ...base.mcp?.tools, ...policy?.mcp?.tools } },
    spawn: { ...base.spawn, ...policy?.spawn },
    tools: { ...base.tools, ...policy?.tools },
  }
}

export function compileRoleSecurity(roleType: string | undefined, role?: RoleConfig): CompiledRoleSecurity {
  const resolvedType = roleType || 'unassigned'
  const policy = mergePolicy(role?.permissions)
  const policyHash = createHash('sha256')
    .update(JSON.stringify({ version: 1, roleType: resolvedType, policy }))
    .digest('hex')
  return { roleType: resolvedType, policy, policyHash }
}

function matchingEffect(rules: Record<string, RolePermissionEffect> | undefined, name: string): RolePermissionEffect {
  if (!rules) return 'inherit'
  const candidates = Object.entries(rules)
    .filter(([pattern]) => pattern === name || (pattern.endsWith('*') && name.startsWith(pattern.slice(0, -1))))
    .sort(([a], [b]) => b.length - a.length)
  return candidates[0]?.[1] ?? 'inherit'
}

function contained(workspace: string | undefined, candidate: unknown): boolean {
  if (!workspace || typeof candidate !== 'string' || !candidate.trim()) return false
  if (!existsSync(workspace)) return false
  const root = realpathSync.native(resolve(workspace))
  const target = isAbsolute(candidate) ? resolve(candidate) : resolve(root, candidate)
  let ancestor = target
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return false
    ancestor = parent
  }
  const realAncestor = realpathSync.native(ancestor)
  const suffix = relative(ancestor, target)
  const realTarget = resolve(realAncestor, suffix)
  const rel = relative(root, realTarget)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function hashAuthorization(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function addEffect(
  current: 'allow' | 'ask' | 'deny',
  effect: RolePermissionEffect,
): 'allow' | 'ask' | 'deny' {
  if (effect === 'deny') return 'deny'
  if (effect === 'ask' && current !== 'deny') return 'ask'
  return current
}

export function authorizeToolCall(input: {
  security: CompiledRoleSecurity
  name: string
  args: Record<string, unknown>
  workspace?: string
  configuredLevel: SupervisionLevel
  legacySafe?: boolean
  /**
   * 配置管理核心角色（senseTable 含 config_manage/install_skill）读放行：
   * 'any' = read_file/search_codebase 读取范围整体放行（绕过 filesystem workspace 校验，即使策略 deny）；
   * 缺省 'workspace' = 保持现有策略。只作用于读，write_file/execute_command 不受影响。
   * 不进 assessmentHash（两处授权同源计算 → hash 恒等，不误触 tool.ts 的「策略或参数已变化」校验）。
   */
  filesystemRead?: 'workspace' | 'any'
  /** 角色验收专用的冻结覆盖层；存在时路径基准强制取其临时工作区。 */
  acceptance?: AcceptanceExecutionPolicy
}): ToolAuthorization {
  const { security, name, args } = input
  const workspace = input.acceptance?.workspaceRoot ?? input.workspace
  const { policy } = security
  const findings: SecurityFinding[] = []
  let decision: 'allow' | 'ask' | 'deny' = 'allow'
  let requiredSandboxMode: SandboxMode | undefined

  if (input.acceptance && !input.acceptance.allowedTools.includes(name)) {
    decision = 'deny'
    findings.push({
      code: 'acceptance.tool-denied',
      category: 'unknown',
      severity: 'high',
      message: `角色验收不允许执行工具 ${name}`,
    })
  }

  decision = addEffect(decision, matchingEffect(policy.tools, name))
  if (name.startsWith('mcp__')) {
    decision = addEffect(decision, matchingEffect(policy.mcp?.tools, name))
    decision = addEffect(decision, policy.mcp?.default ?? 'inherit')
    if (decision !== 'allow') findings.push({
      code: 'role.mcp-policy', category: 'unknown', severity: 'unknown',
      message: `角色 ${security.roleType} 的 MCP 默认策略为 ${decision}`,
    })
  } else if (!HARMLESS_TOOLS.has(name) && !MUTATING_TOOLS.has(name) && name !== 'execute_command' && name !== 'spawn_role') {
    if (policy.template !== 'trusted') decision = addEffect(decision, 'ask')
    findings.push({ code: 'role.unknown-tool', category: 'unknown', severity: 'unknown', message: `工具 ${name} 未声明副作用，按未知工具监管` })
  }

  if (name === 'write_file' || name === 'read_file' || name === 'search_codebase') {
    const path = args.path
    const write = name === 'write_file'
    const scope = write
      ? policy.filesystem?.write
        : !input.acceptance && input.filesystemRead === 'any'
        ? 'any'
        : policy.filesystem?.read
    if (scope === 'deny') decision = 'deny'
    else if (scope === 'workspace' && !contained(workspace, path)) decision = 'deny'
    else if (write && scope === 'any-with-approval' && !contained(workspace, path)) decision = addEffect(decision, 'ask')
    if (decision !== 'allow') findings.push({
      code: `role.filesystem-${write ? 'write' : 'read'}`,
      category: 'filesystem', severity: write ? 'high' : 'medium',
      message: `角色 ${security.roleType} 的${write ? '写入' : '读取'}范围不允许直接访问该路径`,
      fragment: typeof path === 'string' ? path : undefined,
    })
  }

  if (MUTATING_TOOLS.has(name)) {
    if (policy.template === 'read-only') decision = 'deny'
    else if (policy.template === 'supervised') decision = addEffect(decision, 'ask')
  }

  if (name === 'spawn_role') {
    decision = addEffect(decision, policy.spawn?.effect ?? 'inherit')
    const target = typeof args.type === 'string' ? args.type : ''
    if (policy.spawn?.allowedRoles && !policy.spawn.allowedRoles.includes(target)) decision = 'deny'
    if (decision !== 'allow') findings.push({ code: 'role.spawn-policy', category: 'process', severity: 'medium', message: `角色 ${security.roleType} 不可直接派遣 ${target || '未知角色'}` })
  }

  let commandAssessment: ReturnType<typeof assessCommandRisk> | undefined
  if (name === 'execute_command') {
    const shell = args.shell
    const command = args.command
    if ((shell !== 'bash' && shell !== 'powershell') || typeof command !== 'string') {
      decision = 'deny'
      findings.push({ code: 'shell.invalid-arguments', category: 'unknown', severity: 'unknown', message: 'execute_command 必须明确提供 bash 或 powershell 方言' })
    } else if (!(policy.commands?.shells ?? []).includes(shell)) {
      decision = 'deny'
      findings.push({ code: 'role.shell-denied', category: 'system', severity: 'high', message: `角色 ${security.roleType} 不允许使用 ${shell}` })
    } else {
      if (typeof args.workdir === 'string' && !contained(workspace, args.workdir)) {
        decision = 'deny'
        findings.push({ code: 'role.workdir-denied', category: 'filesystem', severity: 'high', message: '命令工作目录越出会话工作区', fragment: args.workdir })
      }
      commandAssessment = assessCommandRisk(shell, command, workspace)
      findings.push(...commandAssessment.findings)
      requiredSandboxMode = commandAssessment.requiredMode
      const maxMode = policy.commands?.maxSandboxMode ?? 'read-only'
      if (sandboxModeRank(requiredSandboxMode) > sandboxModeRank(maxMode)) decision = 'deny'
      else if (commandAssessment.decision === 'approval-required') decision = addEffect(decision, 'ask')
      else if (policy.template === 'supervised' && requiredSandboxMode !== 'read-only') decision = addEffect(decision, 'ask')
      for (const finding of commandAssessment.findings) {
        decision = addEffect(decision, policy.commands?.categories?.[finding.category] ?? 'inherit')
      }
      if (input.acceptance) {
        if (
          sandboxModeRank(requiredSandboxMode) >
          sandboxModeRank(input.acceptance.maxCommandSandboxMode)
        ) {
          decision = 'deny'
        }
        const forbidden = commandAssessment.findings.filter((finding) =>
          ACCEPTANCE_DENIED_COMMAND_CATEGORIES.has(finding.category),
        )
        if (forbidden.length > 0) {
          decision = 'deny'
          findings.push({
            code: 'acceptance.command-risk-denied',
            category: 'unknown',
            severity: 'high',
            message: `角色验收拒绝高风险命令分类：${[...new Set(forbidden.map((finding) => finding.category))].join(', ')}`,
          })
        }
      }
    }
  }

  // manual 永远要求审批；smart 继续消费非命令 Sense 的既有确定性规则。
  if (input.configuredLevel === SupervisionLevel.manual) decision = addEffect(decision, 'ask')
  else if (input.configuredLevel === SupervisionLevel.smart && name !== 'execute_command' && input.legacySafe === false) decision = addEffect(decision, 'ask')

  const assessmentHash = hashAuthorization({
    version: 2,
    roleType: security.roleType,
    policyHash: security.policyHash,
    name,
    args,
    workspace,
    findings,
    commandAssessmentHash: commandAssessment?.assessmentHash,
    acceptance: input.acceptance,
  })
  return {
    decision,
    roleType: security.roleType,
    policyHash: security.policyHash,
    requiredSandboxMode,
    findings,
    assessmentHash,
  }
}
