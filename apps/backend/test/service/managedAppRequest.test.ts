import { describe, expect, it, vi } from 'vitest'
import { prepareRequest } from '@/agent/hooks/request.js'
import { createMockContext, createMockRuntime, createTestSense } from '../agent/helpers/fakeContext.js'
import { authorizeToolCall, compileRoleSecurity } from '@/core/security/rolePolicy.js'
import { SupervisionLevel } from '@/core/config.js'
import * as executionMode from '@/core/security/executionMode.js'
import * as chats from '@/db/chat.js'

const identity = { source: 'plugin' as const, ownerId: 'test-qq', channel: 'qq', subject: { selfId: '123456789', userId: '649207438', conversationType: 'private' as const } }
const forbidden = ['execute_command', 'read_file', 'write_file', 'search_codebase', 'config_manage', 'install_skill', 'role_acceptance', 'send_to_child', 'mcp__host__shell']

describe('managed request runtime ceiling', () => {
  it('filters unsafe tools from model schema, table and frozen request snapshot', async () => {
    const senses = [...forbidden, 'managed_app'].map(name => createTestSense(name, async () => ({ content: 'test' })))
    const ctx = createMockContext({ runtime: createMockRuntime({ senses }) })
    await prepareRequest(ctx, { content: 'test', time: 1, requestIdentity: identity })
    expect(ctx.runtime!.builtSenses.map(s => s.function.name)).toEqual(['managed_app'])
    expect([...ctx.runtime!.senseTable.keys()]).toEqual(['managed_app'])
    expect(ctx.requestView!.tools.map(t => t.name)).toEqual(['managed_app'])
  })
  it('restores stored child identity even when follow-up input has no identity', async () => {
    const get = vi.spyOn(chats, 'getChat').mockReturnValue({ metadata: JSON.stringify({ managedRequestIdentity: identity }) } as never)
    try {
      const ctx = createMockContext({ runtime: createMockRuntime({ senses: [createTestSense('execute_command', async () => ({ content: 'unsafe' }))] }) })
      await prepareRequest(ctx, { content: 'child continuation', time: 1 })
      expect(ctx.requestView!.identity).toEqual(identity)
      expect(ctx.runtime!.senseTable.has('execute_command')).toBe(false)
    } finally { get.mockRestore() }
  })
  it('restores permission ceiling for an empty-input resume after runtime rebuild', async () => {
    const get = vi.spyOn(chats, 'getChat').mockReturnValue({ parent_chat_id: 'parent', metadata: JSON.stringify({ managedRequestIdentity: identity }) } as never)
    try {
      const ctx = createMockContext({ runtime: createMockRuntime({ senses: [createTestSense('execute_command', async () => ({ content: 'unsafe' }))] }) })
      const { checkpointMiddleware } = await import('@/agent/middleware/checkpoint.js')
      const { collectChunks } = await import('../agent/helpers/chunkAssert.js')
      await collectChunks(checkpointMiddleware(ctx, async function* () {}))
      expect(ctx.requestView!.identity).toEqual(identity)
      expect(ctx.runtime!.senseTable.has('execute_command')).toBe(false)
    } finally { get.mockRestore() }
  })
  it('inherits missing child identity from the parent and rejects a broken parent chain', async () => {
    const get = vi.spyOn(chats, 'getChat').mockImplementation((id) =>
      ({ metadata: id === 'parent' ? JSON.stringify({ managedRequestIdentity: identity }) : '{}', parent_chat_id: id === 'parent' ? null : 'parent' }) as never)
    try {
      const ctx = createMockContext({ runtime: createMockRuntime({ senses: [createTestSense('execute_command', async () => ({ content: 'unsafe' }))] }) })
      await prepareRequest(ctx, { content: '', time: 1 })
      expect(ctx.requestView!.identity).toEqual(identity)
      expect(ctx.runtime!.senseTable.has('execute_command')).toBe(false)
      get.mockReturnValue({ metadata: '{}', parent_chat_id: 'missing' } as never)
      await expect(prepareRequest(ctx, { content: '', time: 1 })).rejects.toThrow('APP_ACCESS_DENIED')
    } finally { get.mockRestore() }
  })
  it.each(forbidden)('trusted role and direct mode cannot authorize %s', name => {
    const direct = vi.spyOn(executionMode, 'directContainerExecution').mockReturnValue(true)
    try {
      const security = compileRoleSecurity('trusted', { brain: 'test', senseGroup: 'test', permissions: { template: 'trusted' } })
      const result = authorizeToolCall({ security, name, args: { shell: 'bash', command: 'pwd' }, configuredLevel: SupervisionLevel.auto, requestIdentity: identity })
      expect(result.decision).toBe('deny')
      expect(result.findings[0].code).toBe('managed.backend-denied')
    } finally { direct.mockRestore() }
  })
})
