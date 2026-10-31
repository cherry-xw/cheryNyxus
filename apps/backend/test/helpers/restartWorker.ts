import { spawn } from 'node:child_process'
import {
  configureRestartCoordinator,
  requestRestartWhenIdle,
  subscribeRestartState,
} from '../../src/service/restartCoordinator.js'
import { getBashProcessActivity } from '../../src/agent/sense/processRegistry.js'
import { registerHostCommand, releaseHostCommand } from '../../src/service/hostCommands.js'
import { CommandRuntime } from '../../src/service/commandRuntime.js'
import { AgentCommandRepository, initAgentCommandTables } from '../../src/db/agentCommands.js'
import Database from 'better-sqlite3'

const db = new Database(':memory:')
db.exec("CREATE TABLE chats(id TEXT PRIMARY KEY); INSERT INTO chats VALUES('isolated-chat')")
initAgentCommandTables(db)
const runtime = new CommandRuntime(new AgentCommandRepository(db), {
  backendInstanceId: 'isolated', environment: {}, minimumBareSecretLength: 8,
})
const handle = runtime.start({ chatId: 'isolated-chat', rootChatId: 'isolated-chat', runId: null,
  toolCallId: null, sourceKind: 'host_bash', command: 'node controlled background task',
  description: 'isolated background task', workdir: null }, () => {})

const command = spawn(
  process.execPath,
  ['-e', "process.stdin.once('data',()=>process.exit(0)); setTimeout(()=>process.exit(0),10000)"],
  { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, detached: process.platform !== 'win32' },
)
registerHostCommand('isolated-chat', command, handle, 'isolated')
command.once('close', async (exitCode, signal) => {
  await releaseHostCommand(command.pid!, 'isolated')
  await handle.finish({ status: 'exited', exitCode, signal })
})
configureRestartCoordinator({
  isIdle: () => true,
  blockers: () =>
    getBashProcessActivity().map(({ chatId, pid, description }) => ({
      kind: 'process',
      chatId,
      pid,
      description,
    })),
  validateBeforeRestart: () => ({ ok: true }),
  onRestartReady: () => {
    process.send?.({ type: 'restart-ready' })
  },
})
subscribeRestartState((state) => process.send?.({ type: 'state', state }))
process.on('message', (message: { type: string }) => {
  if (message.type === 'request') requestRestartWhenIdle()
  if (message.type === 'finish') command.stdin!.end('finish')
  if (message.type === 'shutdown') process.exit(0)
})
process.send?.({ type: 'booted', pid: command.pid })
