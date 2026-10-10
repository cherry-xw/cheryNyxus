import { afterEach, describe, expect, it, vi } from 'vitest'
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
  it('要求调用方明确声明 Bash 或 PowerShell 方言', () => {
    expect(bashSense.definition.function.name).toBe('execute_command')
    expect(bashSense.supervisionLevel).toBe(SupervisionLevel.smart)
    expect(bashSense.definition.function.parameters.required).toContain('shell')
    expect(bashSense.definition.function.parameters.properties.shell?.enum).toEqual([
      'bash',
      'powershell',
    ])
  })

  it('没有会话工作区时 fail closed', async () => {
    const result = await exec(
      { shell: 'bash', command: 'echo test', description: 'test' },
      sharedData,
      { chatId: 'missing-workspace' },
    )
    expect(result.content).toContain('没有有效工作区')
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
