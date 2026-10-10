import { afterEach, describe, expect, it, vi } from 'vitest'
import * as executionMode from '@/core/security/executionMode.js'
import bashSense from '@/agent/sense/bash.js'
import { SupervisionLevel } from '@/core/config.js'
import { getAppliedRawConfig, replaceRuntimeConfig } from '@/utils/config.js'
import { logger } from '@/utils/logger/index.js'

const exec = bashSense.executor.execute.bind(bashSense.executor)
const sharedData = new Map<string, Map<string, unknown>>()
const baseline = getAppliedRawConfig()

afterEach(() => {
  replaceRuntimeConfig(baseline)
  vi.restoreAllMocks()
})

describe('execute_command sense 定义', () => {
  it('直接模式无需工作区或沙箱授权即可实际执行', async () => {
    vi.spyOn(executionMode, 'directContainerExecution').mockReturnValue(true)
    const result = await exec({ shell: 'bash', command: 'printf direct-execution-ok', description: 'probe' }, sharedData, { chatId: 'direct-probe' })
    expect(result.content).toContain('状态: success')
    expect(result.content).toContain('direct-execution-ok')
  })

  it('要求调用方明确声明 Bash 或 PowerShell 方言', () => {
    expect(bashSense.definition.function.name).toBe('execute_command')
    expect(bashSense.supervisionLevel).toBe(SupervisionLevel.smart)
    expect(bashSense.definition.function.parameters.required).toContain('shell')
    expect(bashSense.definition.function.parameters.properties.shell?.enum).toEqual([
      'bash',
      'powershell',
    ])
  })

  it('没有会话工作区时仍检查执行授权而非拒绝工作区', async () => {
    const result = await exec(
      { shell: 'bash', command: 'echo test', description: 'test' },
      sharedData,
      { chatId: 'missing-workspace' },
    )
    expect(result.content).toContain('缺少已复核的沙箱授权')
  })

  it('没有统一工具门签发的沙箱模式时 fail closed', async () => {
    const result = await exec(
      { shell: 'powershell', command: 'Get-Location', description: 'test' },
      sharedData,
      { chatId: 'missing-security', workspaceRoot: process.cwd() },
    )
    expect(result.content).toContain('缺少已复核的沙箱授权')
  })

  it('每次操作读取最新的日志保留配置', async () => {
    const clean = vi.spyOn(logger.tools, 'cleanOldBashLogs').mockImplementation(() => {})
    const first = getAppliedRawConfig()
    first.global.bash_log_retention_hours = 3
    replaceRuntimeConfig(first)
    await exec({ shell: 'bash', command: 'echo test', description: 'test' }, sharedData, {
      chatId: 'missing-workspace',
    })

    const second = getAppliedRawConfig()
    second.global.bash_log_retention_hours = 7
    replaceRuntimeConfig(second)
    await exec({ shell: 'bash', command: 'echo test', description: 'test' }, sharedData, {
      chatId: 'missing-workspace',
    })

    expect(clean.mock.calls.map(([hours]) => hours)).toEqual([3, 7])
  })
})
