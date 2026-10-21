import { spawn, type ChildProcess } from 'node:child_process'

export type ManagedProcessName = 'backend' | 'rathole'
export interface ManagedProcessState {
  name: ManagedProcessName
  running: boolean
  pid?: number
  exitCode?: number | null
  error?: string
}

export class ProcessStartError extends Error {
  constructor(
    public readonly processName: ManagedProcessName,
    message: string,
  ) {
    super(message)
  }
}

/** 组级终止：先对整组（负 PID）发 SIGTERM，5 秒后仍未退出则整组 SIGKILL；跨平台回退单进程信号。 */
export function terminateTree(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const groupKill = (signal: NodeJS.Signals): boolean => {
      if (child.pid === undefined || process.platform === 'win32') return false
      try {
        process.kill(-child.pid, signal)
        return true
      } catch {
        return false
      }
    }
    const signalExit = (signal: NodeJS.Signals): void => {
      if (!groupKill(signal)) child.kill(signal)
    }
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signalExit('SIGKILL')
      resolve()
    }, 5_000)
    timer.unref()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    signalExit('SIGTERM')
  })
}

/** 自管子进程桥接：由注册方（如 BackendSupervisor）动态提供存活/ PID 与受控停止。 */
export interface AdoptedProcessBridge {
  isAlive(): boolean
  pid(): number | undefined
  stop(): Promise<unknown>
}

export class ProcessController {
  private readonly children = new Map<ManagedProcessName, ChildProcess>()
  private readonly bridges = new Map<ManagedProcessName, AdoptedProcessBridge>()
  private readonly states = new Map<ManagedProcessName, ManagedProcessState>()
  private readonly operations = new Map<ManagedProcessName, Promise<unknown>>()

  constructor() {
    for (const name of ['backend', 'rathole'] as const) this.states.set(name, { name, running: false })
  }

  state(): ManagedProcessState[] {
    return (['backend', 'rathole'] as const).map((name) => {
      const bridge = this.bridges.get(name)
      if (bridge) return bridge.isAlive() ? { name, running: true, pid: bridge.pid() } : { name, running: false }
      return { ...this.states.get(name)! }
    })
  }

  /** 该进程是否由管理器作为子进程拉起（否则视为外部启动，无法由管理器重启）。 */
  isManaged(name: ManagedProcessName): boolean {
    return this.children.has(name) || (this.bridges.get(name)?.isAlive() ?? false)
  }

  /**
   * 注册自管子进程桥接（如 BackendSupervisor 拉起的受管 Backend）：
   * 纳入 isManaged / state / stop / stopAll 语义；存活与 PID 动态读取，进程内部重启后自动跟随。
   */
  adopt(name: ManagedProcessName, bridge: AdoptedProcessBridge): void {
    this.bridges.set(name, bridge)
  }

  start(name: ManagedProcessName, command: string, args: string[], env?: NodeJS.ProcessEnv): ManagedProcessState {
    if (this.children.get(name) || this.bridges.get(name)?.isAlive()) return this.state().find((item) => item.name === name)!
    const child = spawn(command, args, {
      env: { ...process.env, ...env },
      stdio: 'ignore',
      windowsHide: true,
      // 独立进程组：管理器关闭/重启时整组（含子进程派生树）一并退出，不留孤儿。
      detached: process.platform !== 'win32',
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

  private async exclusive<T>(name: ManagedProcessName, operation: () => Promise<T>): Promise<T> {
    const previous = this.operations.get(name) ?? Promise.resolve()
    const current = previous.then(operation, operation)
    this.operations.set(name, current)
    try {
      return await current
    } finally {
      if (this.operations.get(name) === current) this.operations.delete(name)
    }
  }

  async startExclusive(name: ManagedProcessName, command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ManagedProcessState> {
    return this.exclusive(name, async () => {
      const state = this.start(name, command, args, env)
      const child = this.children.get(name)
      if (!child) return state
      await new Promise<void>((resolve, reject) => {
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          error ? reject(error) : resolve()
        }
        child.once('error', (error) => finish(new ProcessStartError(name, error.message)))
        child.once('exit', (code, signal) => {
          if (code !== null || signal !== null)
            finish(new ProcessStartError(name, `进程立即退出（退出码 ${code ?? '未知'}，信号 ${signal ?? '无'}）`))
        })
        setImmediate(() => finish())
      })
      return this.states.get(name) ?? state
    })
  }

  async stop(name: ManagedProcessName): Promise<ManagedProcessState> {
    const bridge = this.bridges.get(name)
    if (bridge?.isAlive()) {
      await bridge.stop()
      return this.state().find((item) => item.name === name)!
    }
    const child = this.children.get(name)
    if (!child) return this.states.get(name)!
    await terminateTree(child)
    return this.states.get(name)!
  }

  async restart(name: ManagedProcessName, command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ManagedProcessState> {
    await this.stop(name)
    return this.start(name, command, args, env)
  }

  async stopExclusive(name: ManagedProcessName): Promise<ManagedProcessState> {
    return this.exclusive(name, () => this.stop(name))
  }

  async restartExclusive(name: ManagedProcessName, command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<ManagedProcessState> {
    return this.exclusive(name, () => this.restart(name, command, args, env))
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.children.keys()].map((name) => this.stop(name)))
  }
}
