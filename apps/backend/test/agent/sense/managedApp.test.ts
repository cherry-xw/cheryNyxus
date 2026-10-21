import { describe, expect, it, vi } from 'vitest'
import { createManagedAppSense, managedAppSchema } from '@/agent/sense/managedApp.js'
import { ControllerSocketClient } from '@/service/managedApp/socketRpc.js'
import { ManagedAppError } from '@/service/managedApp/types.js'
import { sense, type SenseRuntimeContext } from '@/core/sense/senseCreator.js'
import { managedToolDenied } from '@/core/security/managedRequest.js'
import { z } from 'zod'

// This suite tests the tool's identity/format boundary; command ownership has its own runtime tests.
vi.mock('@/service/commands.js', () => ({ getCommandRuntime: () => undefined }))

function context(group = false): SenseRuntimeContext {
  return { chatId: 'test', requestView: { requestId: 'test', inputId: 'test', chatId: 'test', preparedAt: 0, configRevision: 'test', registryVersion: 0, tools: [], unavailableTools: [], contexts: [], identity: { source: 'plugin', ownerId: 'qq-module', channel: 'qq', subject: { selfId: '123456789', userId: '649207438', conversationType: group ? 'group' : 'private', ...(group ? { groupId: '987654321' } : {}) } } } }
}
function fixture() {
  const client = new ControllerSocketClient('/nonexistent-test-socket')
  const inspect = vi.spyOn(client, 'inspectAppStatus').mockResolvedValue([])
  return { client, inspect, tool: createManagedAppSense(client) }
}

describe('managed_app trusted identity and execution boundary', () => {
  it.each(['userId', 'ownerId', 'image', 'mount', 'privileged'])('rejects model supplied %s', async key => {
    expect(managedAppSchema.safeParse({ action: 'status', [key]: 'forged' }).success).toBe(false)
  })
  it('rejects missing identity and OpenID without calling controller', async () => {
    const { tool, inspect } = fixture()
    for (const ctx of [undefined, { chatId: 'web' }, context()]) {
      if (ctx?.requestView?.identity.subject) ctx.requestView.identity.subject.userId = '74B88543EE2CC173418104185151205E'
      const result = await tool.executor.execute({ action: 'status' }, new Map(), ctx)
      expect(JSON.parse(result.content).error.code).toBe('IDENTITY_REQUIRED')
    }
    expect(inspect).not.toHaveBeenCalled()
  })
  it('derives user from trusted subject rather than ownerId', async () => {
    const { tool, inspect } = fixture()
    await tool.executor.execute({ action: 'status' }, new Map(), context())
    expect(inspect).toHaveBeenCalledWith({ userId: '649207438', appId: undefined })
  })
  it('redacts internal controller fields and group activation link', async () => {
    const { tool, client } = fixture()
    vi.spyOn(client, 'startAppService').mockResolvedValue({ appId: 'test-app', userId: '649207438', state: 'running', appUrl: 'https://example.org/', activationUrl: 'https://example.org/?activate_token=test-only', containerIp: '172.29.0.3', health: 'ok', leaseExpiresAt: 0, idleTimeoutHours: 24 })
    const result = JSON.parse((await tool.executor.execute({ action: 'publish', appId: 'test-app' }, new Map(), context(true))).content)
    expect(result.result).not.toHaveProperty('activationUrl')
    expect(result.result).not.toHaveProperty('containerIp')
    expect(result.result).not.toHaveProperty('userId')
  })
  it('returns actionable missing appId and accepts a corrected create', async () => {
    const { tool, client } = fixture()
    const ensure = vi.spyOn(client, 'ensureAppWorkspace').mockResolvedValue({ appId: 'vue-hello-service' } as never)
    const failed = await tool.executor.execute({ action: 'create', title: 'Vue Hello World' }, new Map(), context(true))
    expect(JSON.parse(failed.content)).toMatchObject({ ok: false, error: { code: 'INVALID_INPUT', message: expect.stringContaining('appId') } })
    expect(ensure).not.toHaveBeenCalled()
    const corrected = await tool.executor.execute({ action: 'create', appId: 'vue-hello-service', title: 'Vue Hello World' }, new Map(), context(true))
    expect(JSON.parse(corrected.content)).toMatchObject({ ok: true, result: { appId: 'vue-hello-service' } })
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ userId: '649207438', appId: 'vue-hello-service' }))
  })
  it('keeps structured controller errors', async () => {
    const { tool, inspect } = fixture()
    inspect.mockRejectedValue(new ManagedAppError('APP_ACCESS_DENIED', '禁止访问'))
    expect(JSON.parse((await tool.executor.execute({ action: 'status' }, new Map(), context())).content).error.code).toBe('APP_ACCESS_DENIED')
  })
  it('does not start pre-cancelled operations', async () => {
    const { tool, inspect } = fixture()
    const abort = new AbortController(); abort.abort()
    const result = await tool.executor.execute({ action: 'status' }, new Map(), { ...context(), signal: abort.signal })
    expect(result.status).toBe('cancelled')
    expect(inspect).not.toHaveBeenCalled()
  })
  it.each(['execute_command', 'read_file', 'write_file', 'search_codebase', 'config_manage', 'install_skill', 'role_acceptance', 'send_to_child', 'mcp__host__shell'])('blocks direct executor %s', async name => {
    const handler = vi.fn(async () => ({ content: 'unsafe' }))
    const tool = sense(name, 'test', z.object({}), handler)
    expect(managedToolDenied(name, context().requestView!.identity)).toBe(true)
    await expect(tool.executor.execute({}, new Map(), context())).rejects.toMatchObject({ code: 'APP_ACCESS_DENIED' })
    expect(handler).not.toHaveBeenCalled()
    expect(await tool.executor.execute({}, new Map(), { chatId: 'web' })).toEqual({ content: 'unsafe' })
  })
  it('passes generated task id for cancellation and clamps standard timeout', async () => {
    const { tool, client } = fixture()
    const run = vi.spyOn(client, 'runAppCommand').mockResolvedValue({} as never)
    await tool.executor.execute({ action: 'exec', appId: 'test-app', command: 'node --version', timeoutSec: 300 }, new Map(), context())
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ userId: '649207438', taskId: expect.stringMatching(/^task_[a-f0-9]{16}$/), timeoutSec: 180 }), expect.any(Function))
  })
})
