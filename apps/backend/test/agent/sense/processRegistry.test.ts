import Database from 'better-sqlite3'
import type { ChildProcess } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBashProcessActivity, killBashProcess, listBashProcesses } from '@/agent/sense/processRegistry.js'
import { registerHostCommand, releaseHostCommand, requestHostCommandStop } from '@/service/hostCommands.js'
import { CommandRuntime, type RunningCommand } from '@/service/commandRuntime.js'
import { AgentCommandRepository, initAgentCommandTables } from '@/db/agentCommands.js'

let db: Database.Database
let runtime: CommandRuntime
const owned: Array<{ pid: number; handle: RunningCommand }> = []

beforeEach(() => {
  db = new Database(':memory:')
  db.exec("CREATE TABLE chats(id TEXT PRIMARY KEY); INSERT INTO chats VALUES('one'),('two')")
  initAgentCommandTables(db)
  runtime = new CommandRuntime(new AgentCommandRepository(db), {
    backendInstanceId: 'fixture', environment: {}, minimumBareSecretLength: 8,
  })
  // Synthetic PIDs must never send a signal to a real process.
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
})
afterEach(async () => {
  for (const { pid, handle } of owned.splice(0)) {
    await releaseHostCommand(pid, 'fixture')
    await handle.finish({ status: 'exited', exitCode: 0 })
  }
  db.close()
  vi.restoreAllMocks()
})

function register(chatId = 'one', pid = 2_147_000_001) {
  const cancel = vi.fn(() => { requestHostCommandStop(pid) })
  const handle = runtime.start({ chatId, rootChatId: chatId, runId: null, toolCallId: null,
    sourceKind: 'host_bash', command: 'background', description: 'work', workdir: null }, cancel)
  const child = { pid } as ChildProcess
  registerHostCommand(chatId, child, handle, 'fixture')
  owned.push({ pid, handle })
  return { handle, child, cancel }
}

describe('bash views share the unified command owner', () => {
  it('lists command identity and metadata without leaking executable handles', () => {
    const { handle } = register()
    expect(listBashProcesses('one')).toEqual([expect.objectContaining({ pid: 2_147_000_001,
      chatId: 'one', commandId: handle.commandId, command: 'background', description: 'work', killed: false })])
    expect(getBashProcessActivity()).toHaveLength(1)
    for (const item of getBashProcessActivity()) {
      expect(item).not.toHaveProperty('child')
      expect(item).not.toHaveProperty('proc')
    }
  })

  it('isolates per-chat listing and refuses cancellation from another chat', async () => {
    const one = register('one')
    register('two', 2_147_000_002)
    expect(listBashProcesses('one').map(item => item.pid)).toEqual([2_147_000_001])
    expect(listBashProcesses('two').map(item => item.pid)).toEqual([2_147_000_002])
    expect(listBashProcesses('missing')).toEqual([])
    expect(killBashProcess('two', 2_147_000_001)).toBe(false)
    expect(killBashProcess('one', 2_147_000_003)).toBe(false)
    await Promise.resolve()
    expect(one.cancel).not.toHaveBeenCalled()
  })

  it('coalesces cancellation and keeps the command blocking until observed release', async () => {
    const { handle, cancel } = register()
    handle.background()
    expect(killBashProcess('one', 2_147_000_001)).toBe(true)
    expect(killBashProcess('one', 2_147_000_001)).toBe(true)
    await handle.requestCancel()
    expect(cancel).toHaveBeenCalledOnce()
    expect(process.kill).toHaveBeenCalledWith(-2_147_000_001, 'SIGTERM')
    expect(runtime.get(handle.commandId)).toMatchObject({ status: 'cancel_requested', endedAt: null })
    expect(getBashProcessActivity()).toMatchObject([{ killed: true }])
    expect(runtime.blockers()).toHaveLength(1)
    await releaseHostCommand(2_147_000_001, 'fixture')
    await handle.finish({ status: 'killed', signal: 'SIGTERM' })
    expect(getBashProcessActivity()).toEqual([])
    expect(runtime.blockers()).toEqual([])
    expect(killBashProcess('one', 2_147_000_001)).toBe(false)
  })

  it('ignores a child without a PID and retains unrelated commands on release', async () => {
    const { handle } = register()
    registerHostCommand('one', {} as ChildProcess, handle, 'fixture')
    await releaseHostCommand(2_147_000_003, 'fixture')
    expect(getBashProcessActivity()).toHaveLength(1)
    expect(requestHostCommandStop(2_147_000_003)).toBe(false)
  })

  it('retains a live process group after shell close until the group disappears', async () => {
    const { handle } = register()
    let alive = true
    vi.mocked(process.kill).mockImplementation(() => {
      if (alive) return true
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    const release = releaseHostCommand(2_147_000_001, 'fixture')
    expect(handle.snapshot().status).toBe('background')
    expect(getBashProcessActivity()).toHaveLength(1)
    alive = false
    // Keep the test process alive while the owner's unref'd group check runs.
    await Promise.all([release, new Promise(resolve => setTimeout(resolve, 120))])
    expect(getBashProcessActivity()).toEqual([])
  })

  it('does not disguise unexpected process signalling errors as successful stop', () => {
    register()
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
    expect(() => requestHostCommandStop(2_147_000_001)).toThrow('denied')
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }) })
  })
})
