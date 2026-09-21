import { spawn, type ChildProcess } from 'node:child_process'

export type ManagedProcessName = 'backend' | 'rathole'
export interface ManagedProcessState {
  name: ManagedProcessName
  running: boolean
  pid?: number
  exitCode?: number | null
  error?: string
}

export class ProcessController {
  private readonly children = new Map<ManagedProcessName, ChildProcess>()
  private readonly states = new Map<ManagedProcessName, ManagedProcessState>()

  constructor() {
    for (const name of ['backend', 'rathole'] as const) this.states.set(name, { name, running: false })
  }

  state(): ManagedProcessState[] {
    return [...this.states.values()].map((state) => ({ ...state }))
  }

  /** 该进程是否由管理器作为子进程拉起（否则视为外部启动，无法由管理器重启）。 */
  isManaged(name: ManagedProcessName): boolean {
    return this.children.has(name)
  }

  start(name: ManagedProcessName, command: string, args: string[], env?: NodeJS.ProcessEnv): ManagedProcessState {
    if (this.children.get(name)) return this.states.get(name)!
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: 'ignore',
      windowsHide: true,
    })
    this.children.set(name, child)
    const state: ManagedProcessState = { name, running: true, pid: child.pid }
    this.states.set(name, state)
    child.once('error', (error) => {
      this.states.set(name, { name, running: false, pid: child.pid, exitCode: child.exitCode, error: error.message })
      this.children.delete(name)
    })
    child.once('exit', (code) => {
      this.states.set(name, { name, running: false, pid: child.pid, exitCode: code })
      this.children.delete(name)
    })
    return { ...state }
  }

  async stop(name: ManagedProcessName): Promise<ManagedProcessState> {
    const child = this.children.get(name)
    if (!child) return this.states.get(name)!
    child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
        resolve()
      }, 5_000)
      child.once('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    return this.states.get(name)!
  }

  async restart(name: ManagedProcessName, command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ManagedProcessState> {
    await this.stop(name)
    return this.start(name, command, args, env)
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.children.keys()].map((name) => this.stop(name)))
  }
}
