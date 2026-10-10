import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('retains a real background process until it exits, then performs one guardian IPC shutdown', async () => {
  const child = fork(fileURLToPath(new URL('../helpers/restartWorker.ts', import.meta.url)), {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  })
  const messages: Array<{
    type: string
    state?: { status: string; blockers?: Array<{ pid: number; chatId: string }> }
  }> = []
  let output = ''
  child.stderr?.on('data', (data) => {
    output += data.toString()
  })
  child.on('message', (message) => messages.push(message as never))
  try {
    await expect
      .poll(() => messages.some((m) => m.type === 'booted'), { timeout: 8000, message: output })
      .toBe(true)
    child.send({ type: 'request' })
    await expect.poll(() => messages.some((m) => m.state?.status === 'blocked')).toBe(true)
    const blocked = messages.find((m) => m.state?.status === 'blocked')!
    expect(blocked.state!.blockers![0]!.chatId).toBe('isolated-chat')
    expect(() => process.kill(blocked.state!.blockers![0]!.pid, 0)).not.toThrow()
    expect(messages.filter((m) => m.type === 'restart-ready')).toHaveLength(0)
    child.send({ type: 'finish' })
    await expect.poll(() => messages.filter((m) => m.type === 'restart-ready').length).toBe(1)
    const exited = once(child, 'exit')
    child.send({ type: 'shutdown' })
    expect(await exited).toEqual([0, null])
    expect(messages.filter((m) => m.type === 'restart-ready')).toHaveLength(1)
  } finally {
    if (child.exitCode === null) {
      child.send({ type: 'finish' })
      const exited = once(child, 'exit')
      child.kill()
      await exited
    }
  }
}, 15000)
