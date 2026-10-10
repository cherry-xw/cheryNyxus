import fs from 'node:fs'
import path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'

const children: ChildProcess[] = []
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    child.kill('SIGKILL')
    await exited
  }
})
function query(child: ChildProcess, action = 'status'): Promise<any> {
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child query timeout')), 5000)
    const receive = (message: any) => {
      if (message.id !== id) return
      clearTimeout(timer)
      child.off('message', receive)
      if (message.error) reject(new Error(message.error))
      else resolve(message)
    }
    child.on('message', receive)
    child.send({ id, action })
  })
}
async function launch(root: string, unknown: boolean) {
  const child = fork(path.resolve('dist/qq-restart-fixture/worker.mjs'), [], {
    execArgv: [],
    env: {
      ...process.env,
      CHERY_DIR: root,
      DB_DIR: path.join(root, 'db'),
      CHERY_ENV_FILE: '/dev/null',
      QQBOT_PLATFORM_TOKEN: 'synthetic-process-token',
      SYNTHETIC_UNKNOWN: unknown ? '1' : '0',
    },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  children.push(child)
  let stderr = ''
  child.stderr!.on('data', (data) => {
    stderr += data.toString()
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child ready timeout: ' + stderr)), 15000)
    child.once('error', reject)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`child exit ${code}: ${stderr}`))
    })
    child.on('message', (message: any) => {
      if (message.ready) {
        clearTimeout(timer)
        resolve()
      }
    })
  })
  await vi.waitFor(async () => {
    const view = await query(child)
    expect(view.status.ready, JSON.stringify({ status: view.status, host: view.hostStatus }) + stderr).toBe(true)
  }, {
    timeout: 10000,
  })
  return child
}
it.each([false, true])(
  'real process kill/restart retains native journal and backend state; unknown=%s never resends or reruns',
  { timeout: 40000 },
  async (unknown) => {
    const root = fs.mkdtempSync(path.join(process.env.CHERY_TEST_RUN_DIR!, 'qq-process-'))
    fs.mkdirSync(path.join(root, '.chery'), { recursive: true })
    fs.writeFileSync(
      path.join(root, '.chery', 'config.yaml'),
      'global:\n  supervision: auto\nllm:\n  brain:\n    synthetic:\n      provider: mock\n      model: synthetic\n',
    )
    const first = await launch(root, unknown)
    await query(first, 'submit')
    await vi.waitFor(
      async () => {
        const view = await query(first)
        expect(view.effects).toEqual({ sends: 1, submissions: unknown ? 0 : 1 })
        expect(view.state.jobs[0].state).toBe(unknown ? 'paused' : 'running')
      },
      { timeout: 10000 },
    )
    const before = (await query(first)).effects
    const exited = new Promise<void>((resolve) => first.once('exit', () => resolve()))
    first.kill('SIGKILL')
    await exited
    const second = await launch(root, false)
    expect(second.pid).not.toBe(first.pid)
    const recovered = await query(second)
    expect(recovered.effects).toEqual(before)
    expect(recovered.state.jobs[0].state).toBe('paused')
    expect(recovered.state.jobs[0].reason).toBe(
      unknown ? 'DELIVERY_UNKNOWN' : 'PROCESS_INTERRUPTED',
    )
    await query(second, 'submit')
    await new Promise((resolve) => setTimeout(resolve, 750))
    const duplicate = await query(second)
    expect(duplicate.effects).toEqual(before)
    expect(duplicate.state.jobs).toHaveLength(1)
  },
)
