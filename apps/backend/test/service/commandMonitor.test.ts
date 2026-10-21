import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { AgentCommandRepository, initAgentCommandTables } from '@/db/agentCommands.js'
import { CommandRuntime } from '@/service/commandRuntime.js'
import type { HandlerContext } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'
import { connectionManager } from '@/service/websocket/connection.js'
import { CommandMonitor } from '@/service/commandMonitor.js'

const chats = vi.hoisted(() => new Map<string, { id: string; parent_chat_id: string | null; metadata: string }>())
vi.mock('@/db/chat.js', () => ({
  getChat: (id: string) => chats.get(id),
  getRootChatId: (id: string): string => {
    let row = chats.get(id)
    while (row?.parent_chat_id) row = chats.get(row.parent_chat_id)
    return row?.id ?? id
  },
}))
vi.mock('@/service/commands.js', () => ({ getCommandRuntime: () => { throw new Error('测试不应隐式初始化运行服务') } }))

function setup() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE chats (id TEXT PRIMARY KEY, parent_chat_id TEXT, metadata TEXT)')
  for (const [id, parent, owner] of [['mine', null, 'alice'], ['child', 'mine', 'alice'], ['other', null, 'bob']] as const) {
    const row = { id, parent_chat_id: parent, metadata: JSON.stringify({ fileOwnerId: owner }) }
    chats.set(id, row)
    db.prepare('INSERT INTO chats VALUES (?, ?, ?)').run(id, parent, row.metadata)
  }
  initAgentCommandTables(db)
  const runtime = new CommandRuntime(new AgentCommandRepository(db), {
    backendInstanceId: 'test', environment: {}, minimumBareSecretLength: 8,
  })
  const monitor = new CommandMonitor(runtime)
  const ws = { readyState: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn() } as unknown as WebSocket
  const connection = connectionManager.create(ws)
  connection.authenticatedUserId = 'alice'
  connection.credentialKind = 'control'
  const ctx: HandlerContext = { authenticatedUserId: 'alice', credentialKind: 'control', connectionId: connection.id, log: logger }
  const start = (chatId: string) => runtime.start({ chatId, rootChatId: chatId === 'child' ? 'mine' : chatId,
    runId: 'run', toolCallId: 'tool', sourceKind: 'host_bash', command: 'echo test', description: 'test', workdir: null }, vi.fn())
  return { db, runtime, monitor, ctx, ws, start, async close() {
    await Promise.all(runtime.liveRecords().map((record) => runtime.cancel(record.commandId)))
    monitor.dispose()
    await connectionManager.close(ws)
    db.close()
  } }
}

describe('command monitor authorization and subscriptions', () => {
  afterEach(() => chats.clear())

  it('filters global pagination before the limit and supports shared session/descendant queries', async () => {
    const s = setup()
    try {
      const first = s.start('mine')
      const second = s.start('child')
      s.start('other')
      const page = s.monitor.list(s.ctx, { scope: 'all', limit: 1 })
      expect(page.commands).toHaveLength(1)
      expect(page.commands[0]!.chatId).not.toBe('other')
      expect(page.nextCursor).not.toBeNull()
      const next = s.monitor.list(s.ctx, { scope: 'all', limit: 1, before: page.nextCursor! })
      expect(new Set([...page.commands, ...next.commands].map((entry) => entry.commandId)))
        .toEqual(new Set([first.commandId, second.commandId]))
      expect(s.monitor.list(s.ctx, { chatId: 'mine' }).commands).toHaveLength(1)
      expect(s.monitor.list(s.ctx, { chatId: 'mine', includeChildren: true }).commands).toHaveLength(2)
      await first.finish({ status: 'exited', exitCode: 0 })
      expect(s.monitor.list(s.ctx, { scope: 'history' }).commands.map((entry) => entry.commandId)).toEqual([first.commandId])
    } finally { await s.close() }
  })

  it('rejects guessed command IDs on get, logs, stop and subscribe without changing the foreign command', async () => {
    const s = setup()
    try {
      const command = s.start('other')
      expect(() => s.monitor.get(s.ctx, command.commandId)).toThrow('无权')
      await expect(s.monitor.logs(s.ctx, { commandId: command.commandId })).rejects.toThrow('无权')
      await expect(s.monitor.stop(s.ctx, command.commandId)).rejects.toThrow('无权')
      expect(() => s.monitor.subscribe(s.ctx, { commandId: command.commandId })).toThrow('无权')
      expect(command.snapshot().status).toBe('running')
      expect(() => s.monitor.list({ ...s.ctx, credentialKind: 'machine' }, {})).toThrow('无权')
    } finally { await s.close() }
  })

  it('sends logs only for explicit command subscriptions and rechecks ownership on every push', async () => {
    const s = setup()
    try {
      const command = s.start('mine')
      const list = s.monitor.subscribe(s.ctx, {})
      const detail = s.monitor.subscribe(s.ctx, { commandId: command.commandId })
      command.background()
      command.write('stdout', Buffer.from('hello\n'))
      await command.finish({ status: 'exited', exitCode: 0 })
      const sent = vi.mocked(s.ws.send).mock.calls.map((call) => JSON.parse(String(call[0])))
      const chunks = sent.filter((item) => item.type === 'agent.command.log.chunk')
      expect(chunks.length).toBeGreaterThan(0)
      expect(chunks.every((item) => item.data.subscriptionId === detail.subscriptionId)).toBe(true)
      expect(sent.some((item) => item.type === 'agent.command.updated' && item.data.subscriptionId === list.subscriptionId)).toBe(true)
      const active = s.start('mine')
      const prior = vi.mocked(s.ws.send).mock.calls.length
      chats.get('mine')!.metadata = JSON.stringify({ fileOwnerId: 'bob' })
      active.background()
      expect(vi.mocked(s.ws.send).mock.calls).toHaveLength(prior)
      expect(s.monitor.unsubscribe({ ...s.ctx, connectionId: 'different' }, detail.subscriptionId)).toEqual({ removed: false })
    } finally { await s.close() }
  })
})
