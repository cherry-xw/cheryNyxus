import { describe, expect, it } from 'vitest'
import { SupervisionLevel } from '@/core/config.js'
import { authorizeToolCall, compileRoleSecurity } from '@/core/security/rolePolicy.js'
import type { AcceptanceExecutionPolicy } from '@/core/security/rolePolicy.js'

const workspace = process.cwd()
const role = (template: 'read-only' | 'workspace-developer' | 'supervised' | 'trusted') => ({
  brain: 'test', senseGroup: 'test', permissions: { template },
})

describe('角色行为权限', () => {
  it('同一个 write_file 可按角色分别拒绝、允许或审核', () => {
    const input = { name: 'write_file', args: { path: 'safe.txt' }, workspace, configuredLevel: SupervisionLevel.auto }
    expect(authorizeToolCall({ ...input, security: compileRoleSecurity('reader', role('read-only')) }).decision).toBe('deny')
    expect(authorizeToolCall({ ...input, security: compileRoleSecurity('developer', role('workspace-developer')) }).decision).toBe('allow')
    expect(authorizeToolCall({ ...input, security: compileRoleSecurity('reviewed', role('supervised')) }).decision).toBe('ask')
  })

  it('MCP 未知工具遵循角色默认策略', () => {
    const result = authorizeToolCall({
      security: compileRoleSecurity('reviewed', role('supervised')),
      name: 'mcp__server__mutate', args: {}, workspace, configuredLevel: SupervisionLevel.auto,
    })
    expect(result.decision).toBe('ask')
  })

  it('工作目录越界或 shell 未获授权时拒绝命令', () => {
    const security = compileRoleSecurity('bash-only', {
      ...role('workspace-developer'),
      permissions: { template: 'workspace-developer', commands: { shells: ['bash'] } },
    })
    const outside = authorizeToolCall({
      security, name: 'execute_command', args: { shell: 'bash', command: 'pwd', workdir: '..' }, workspace,
      configuredLevel: SupervisionLevel.auto,
    })
    expect(outside.decision).toBe('deny')
    const wrongShell = authorizeToolCall({
      security, name: 'execute_command', args: { shell: 'powershell', command: 'Get-Location' }, workspace,
      configuredLevel: SupervisionLevel.auto,
    })
    expect(wrongShell.decision).toBe('deny')
  })

  it('smart 命令按风险动态允许或审核', () => {
    const developer = compileRoleSecurity('developer', role('workspace-developer'))
    const low = authorizeToolCall({
      security: developer, name: 'execute_command', args: { shell: 'bash', command: 'pwd' }, workspace,
      configuredLevel: SupervisionLevel.smart,
    })
    expect(low.decision).toBe('allow')
    expect(low.requiredSandboxMode).toBe('read-only')
    const destructive = authorizeToolCall({
      security: developer, name: 'execute_command', args: { shell: 'bash', command: 'rm generated.txt' }, workspace,
      configuredLevel: SupervisionLevel.smart,
    })
    expect(destructive.decision).toBe('ask')
  })

  it('参数或策略变化会改变授权哈希', () => {
    const security = compileRoleSecurity('developer', role('workspace-developer'))
    const base = { security, name: 'write_file', workspace, configuredLevel: SupervisionLevel.auto }
    const first = authorizeToolCall({ ...base, args: { path: 'a.txt', content: 'a' } })
    const changedArgs = authorizeToolCall({ ...base, args: { path: 'b.txt', content: 'b' } })
    const changedPolicy = compileRoleSecurity('developer', role('read-only'))
    expect(first.assessmentHash).not.toBe(changedArgs.assessmentHash)
    expect(first.policyHash).not.toBe(changedPolicy.policyHash)
  })
})

describe('filesystemRead override（配置管理角色读放行）', () => {
  const security = compileRoleSecurity('reader', role('read-only'))
  const base = {
    security,
    name: 'read_file',
    args: { path: '../../secret.txt' },
    workspace,
    configuredLevel: SupervisionLevel.auto,
  }

  it("read-only + 越界路径 + filesystemRead:'any' → allow（读整体放行）", () => {
    expect(authorizeToolCall({ ...base, filesystemRead: 'any' }).decision).toBe('allow')
  })

  it('同场景不带 override → deny（锚定现状）', () => {
    expect(authorizeToolCall(base).decision).toBe('deny')
  })

  it("会话无 workspace + filesystemRead:'any' → 仍 allow（修复原死锁：无 workspace 不再 fail-closed）", () => {
    expect(authorizeToolCall({ ...base, workspace: undefined, filesystemRead: 'any' }).decision).toBe('allow')
  })

  it("write_file + filesystemRead:'any' → deny（写不受 override 影响）", () => {
    expect(
      authorizeToolCall({
        ...base,
        name: 'write_file',
        args: { path: '../../secret.txt' },
        filesystemRead: 'any',
      }).decision,
    ).toBe('deny')
  })

  it('assessmentHash 含 findings，override 经 findings 间接改变 hash（语义：两处授权须同传 override 保持一致）', () => {
    const without = authorizeToolCall(base) // deny + filesystem-read finding
    const withAny = authorizeToolCall({ ...base, filesystemRead: 'any' }) // allow + 无 finding
    expect(withAny.findings).toEqual([])
    expect(without.findings.length).toBeGreaterThan(0)
    expect(without.assessmentHash).not.toBe(withAny.assessmentHash)
  })
})

describe('角色验收安全覆盖层', () => {
  const acceptance: AcceptanceExecutionPolicy = {
    workspaceRoot: workspace,
    allowedTools: ['read_file', 'write_file', 'execute_command'],
    maxCommandSandboxMode: 'workspace-write',
    preapproveSafeRequests: true,
  }
  const developer = compileRoleSecurity('developer', role('workspace-developer'))

  it('工具白名单和临时工作区不可由普通角色策略放宽', () => {
    expect(
      authorizeToolCall({
        security: developer,
        name: 'config_manage',
        args: { action: 'get' },
        configuredLevel: SupervisionLevel.auto,
        acceptance,
      }).decision,
    ).toBe('deny')
    expect(
      authorizeToolCall({
        security: developer,
        name: 'read_file',
        args: { path: '../../secret.txt' },
        workspace: 'C:/intentionally-ignored',
        configuredLevel: SupervisionLevel.auto,
        filesystemRead: 'any',
        acceptance,
      }).decision,
    ).toBe('deny')
  })

  it('保留角色显式硬拒绝', () => {
    const reader = compileRoleSecurity('reader', role('read-only'))
    expect(
      authorizeToolCall({
        security: reader,
        name: 'write_file',
        args: { path: 'acceptance-output.txt', content: 'ok' },
        configuredLevel: SupervisionLevel.auto,
        acceptance,
      }).decision,
    ).toBe('deny')
  })

  it('允许工作区安全命令，拒绝破坏性与网络命令', () => {
    const authorize = (command: string) =>
      authorizeToolCall({
        security: developer,
        name: 'execute_command',
        args: { shell: 'bash', command, workdir: workspace },
        configuredLevel: SupervisionLevel.smart,
        acceptance,
      })
    expect(authorize('touch acceptance-output.txt').decision).toBe('allow')
    expect(authorize('rm acceptance-output.txt').decision).toBe('deny')
    expect(authorize('curl https://example.com').decision).toBe('deny')
  })

  it('覆盖层内容进入授权哈希', () => {
    const base = {
      security: developer,
      name: 'read_file',
      args: { path: 'package.json' },
      configuredLevel: SupervisionLevel.auto,
    }
    const first = authorizeToolCall({ ...base, acceptance })
    const changed = authorizeToolCall({
      ...base,
      acceptance: { ...acceptance, allowedTools: ['read_file'] },
    })
    expect(first.assessmentHash).not.toBe(changed.assessmentHash)
  })
})
