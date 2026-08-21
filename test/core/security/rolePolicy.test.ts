import { describe, expect, it } from 'vitest'
import { SupervisionLevel } from '@/core/config.js'
import { authorizeToolCall, compileRoleSecurity } from '@/core/security/rolePolicy.js'

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
