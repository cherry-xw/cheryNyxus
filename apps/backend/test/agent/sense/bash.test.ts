import { afterEach, describe, expect, it, vi } from 'vitest'
import * as executionMode from '@/core/security/executionMode.js'
import bashSense from '@/agent/sense/bash.js'
import { SupervisionLevel } from '@/core/config.js'
import { getAppliedRawConfig, replaceRuntimeConfig } from '@/utils/config.js'
import { createChat, deleteChat } from '@/db/chat.js'
import { randomUUID } from 'node:crypto'
import { getCommandRuntime, closeCommandLogs } from '@/service/commands.js'

const exec = bashSense.executor.execute.bind(bashSense.executor)
const sharedData = new Map<string, Map<string, unknown>>()
const baseline = getAppliedRawConfig()

const chats: string[] = []
function chat() {
  const id = randomUUID()
  createChat(id)
  chats.push(id)
  return id
}

afterEach(async () => {
  await closeCommandLogs()
  for (const id of chats.splice(0)) deleteChat(id)
  replaceRuntimeConfig(baseline)
  vi.restoreAllMocks()
})

describe('execute_command sense 定义', () => {
  it('直接模式无需工作区或沙箱授权即可实际执行', async () => {
    vi.spyOn(executionMode, 'directContainerExecution').mockReturnValue(true)
    const result = await exec({ shell: 'bash', command: 'printf direct-execution-ok', description: 'probe' }, sharedData, { chatId: chat() })
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

  it('切换全局配置不改变统一命令原始日志的保存', async () => {
    vi.spyOn(executionMode, 'directContainerExecution').mockReturnValue(true)
    const id = chat()
    const first = getAppliedRawConfig()
    first.global.sense_execute_timeout = 12_000
    replaceRuntimeConfig(first)
    const one = await exec({ shell: 'bash', command: 'printf first-log', description: 'first' }, sharedData, { chatId: id })

    const second = getAppliedRawConfig()
    second.global.sense_execute_timeout = 15_000
    replaceRuntimeConfig(second)
    const two = await exec({ shell: 'bash', command: 'printf second-log', description: 'second' }, sharedData, { chatId: id })
    expect(one.content).toContain('状态: success')
    expect(two.content).toContain('状态: success')
    const runtime = getCommandRuntime()
    const commands = runtime.repository.list({ chatId: id })
    expect(commands).toHaveLength(2)
    for (const command of commands) {
      expect(command).toMatchObject({ status: 'exited', logStatus: 'complete' })
      const page = await runtime.logs.read(command.commandId)
      const text = Buffer.concat(page.chunks.map(chunk => Buffer.from(chunk.dataBase64, 'base64'))).toString()
      expect(text).toBe(command.description === 'first' ? 'first-log' : 'second-log')
    }
  })
})
