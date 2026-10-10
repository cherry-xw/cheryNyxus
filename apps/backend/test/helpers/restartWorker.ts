import { spawn } from 'node:child_process'
import {
  configureRestartCoordinator,
  requestRestartWhenIdle,
  subscribeRestartState,
} from '../../src/service/restartCoordinator.js'
import {
  getBashProcessActivity,
  registerBashProcess,
  unregisterBashProcess,
} from '../../src/agent/sense/processRegistry.js'

const command = spawn(
  process.execPath,
  ['-e', "process.stdin.once('data',()=>process.exit(0)); setTimeout(()=>process.exit(0),10000)"],
  { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true },
)
registerBashProcess('isolated-chat', command, {
  command: 'node controlled background task',
  description: 'isolated background task',
  startedAt: Date.now(),
})
command.once('close', () => unregisterBashProcess('isolated-chat', command.pid!))
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
