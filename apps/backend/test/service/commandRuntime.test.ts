import Database from 'better-sqlite3'
import { describe, expect, it, vi } from 'vitest'
import { AgentCommandRepository, initAgentCommandTables } from '@/db/agentCommands.js'
import { CommandRuntime } from '@/service/commandRuntime.js'

function setup() {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE chats (id TEXT PRIMARY KEY); INSERT INTO chats VALUES (\'chat\')')
  initAgentCommandTables(db)
  const runtime = new CommandRuntime(new AgentCommandRepository(db), {
    backendInstanceId: 'instance', environment: { API_KEY: 'secret-abcdefgh' }, minimumBareSecretLength: 8,
  })
  const input = { chatId: 'chat', rootChatId: 'chat', runId: 'run', toolCallId: 'tool', sourceKind: 'host_bash' as const,
    command: 'echo secret-abcdefgh', description: 'example', workdir: null }
  return { db, runtime, input }
}

describe('CommandRuntime', () => {
  it('keeps background and cancel-requested commands as blockers until actual exit evidence', async () => {
    const { db, runtime, input } = setup()
    try {
      const cancel = vi.fn()
      const handle = runtime.start(input, cancel)
      handle.started('1234')
      handle.background()
      expect(runtime.get(handle.commandId)?.status).toBe('background')
      expect(runtime.blockers()).toMatchObject([{ commandId: handle.commandId, kind: 'command' }])
      await Promise.all([runtime.cancel(handle.commandId), runtime.cancel(handle.commandId)])
      expect(cancel).toHaveBeenCalledOnce()
      expect(runtime.get(handle.commandId)).toMatchObject({ status: 'cancel_requested', endedAt: null })
      expect(runtime.blockers()).toHaveLength(1)
      await handle.finish({ status: 'killed', signal: 'SIGTERM' })
      expect(runtime.get(handle.commandId)).toMatchObject({ status: 'killed', signal: 'SIGTERM', logStatus: 'complete' })
      expect(runtime.blockers()).toEqual([])
      await expect(runtime.cancel(handle.commandId)).resolves.toBe(false)
    } finally { db.close() }
  })

  it('sanitizes before disk, summary and live output without breaking split original byte sequences', async () => {
    const { db, runtime, input } = setup()
    try {
      const live: string[] = []
      runtime.subscribe((event) => { if (event.type === 'agent.command.log.chunk') live.push(event.chunk.dataBase64) })
      const handle = runtime.start(input, () => {})
      handle.write('stdout', Buffer.from('before sec'))
      handle.write('stdout', Buffer.from('ret-abcdefgh after\n'))
      handle.write('stderr', Buffer.from('API_KEY=other-value\n'))
      await handle.finish({ status: 'exited', exitCode: 0 })
      const page = await runtime.logs.read(handle.commandId)
      const text = Buffer.concat(page.chunks.map((entry) => Buffer.from(entry.dataBase64, 'base64'))).toString()
      expect(text).toBe('before [REDACTED] after\nAPI_KEY=[REDACTED]\n')
      expect(Buffer.concat(live.map((entry) => Buffer.from(entry, 'base64'))).toString()).toBe(text)
      expect(JSON.stringify(page.command)).not.toContain('secret-abcdefgh')
      expect(JSON.stringify(page.command.drainSummary)).not.toContain('other-value')
    } finally { db.close() }
  })

  it('keeps cancellation and live ownership usable if command registration cannot be written', async () => {
    const { db, runtime, input } = setup()
    db.close()
    const live: string[] = []
    runtime.subscribe((event) => { if (event.type === 'agent.command.log.chunk') live.push(event.chunk.dataBase64) })
    const cancel = vi.fn()
    const handle = runtime.start(input, cancel)
    expect(handle.snapshot()).toMatchObject({ status: 'running', logStatus: 'write_error' })
    handle.write('stdout', Buffer.from('output'))
    await runtime.cancel(handle.commandId)
    expect(cancel).toHaveBeenCalledOnce()
    expect(runtime.blockers()).toHaveLength(1)
    await expect(handle.finish({ status: 'exited', exitCode: 1 })).resolves.toBeUndefined()
    expect(Buffer.concat(live.map((entry) => Buffer.from(entry, 'base64'))).toString()).toBe('output')
    expect(runtime.blockers()).toEqual([])
  })
})
