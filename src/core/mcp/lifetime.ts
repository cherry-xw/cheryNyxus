import type { McpClientHandle } from './types.js'
import type { Sense } from '@/core/sense'
import type { ZodType } from 'zod'
import { logger } from '@/utils/logger/index.js'
import { trackRestartActivity } from '@/service/restartCoordinator.js'

export interface McpOwner {
  isRunning(): boolean
}

/** A runtime lease covers future calls as well as the RPC currently on the wire. */
export class McpLifetime {
  calls = 0
  suspended = false
  retired = false
  closed = false
  private closing?: Promise<void>
  private owners = new Map<WeakRef<McpOwner>, boolean>()

  constructor(
    public handle: McpClientHandle,
    readonly exclusive = false,
  ) {}

  retain(owner: McpOwner, treeOwned: boolean): () => void {
    const ref = new WeakRef(owner)
    this.owners.set(ref, treeOwned)
    const release = () => {
      this.owners.delete(ref)
      void this.collect()
      notifyIdle()
    }
    finalizers.register(owner, release, ref)
    return () => {
      finalizers.unregister(ref)
      release()
    }
  }

  busy(): boolean {
    return (
      this.calls > 0 ||
      [...this.owners].some(([ref, treeOwned]) => {
        const owner = ref.deref()
        return owner && (!treeOwned || owner.isRunning())
      })
    )
  }

  async collect(): Promise<void> {
    if (this.closed) {
      retired.delete(this)
      return
    }
    for (const ref of this.owners.keys()) if (!ref.deref()) this.owners.delete(ref)
    if (!this.retired || this.calls || this.owners.size || this.closed) return
    try {
      await this.close()
      retired.delete(this)
    } catch {
      // Retain the handle for a later cleanup attempt; never invalidate the new client.
      logger.warn('MCP 旧连接清理失败，将在下次资源操作时重试')
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closing ??= this.handle.close().then(() => {
      this.closed = true
    })
    try {
      await this.closing
    } finally {
      this.closing = undefined
    }
  }

  retire(): void {
    this.retired = true
    retired.add(this)
  }

  revive(): boolean {
    if (this.closed || this.closing || this.suspended) return false
    this.retired = false
    retired.delete(this)
    return true
  }
}

const finalizers = new FinalizationRegistry<() => void>((release) => release())
const executors = new WeakMap<object, McpLifetime>()
const retired = new Set<McpLifetime>()
let onIdle: (() => void) | undefined
let idleTimer: ReturnType<typeof setTimeout> | undefined
export function setMcpIdleListener(listener: () => void): void {
  onIdle = listener
}
function notifyIdle(): void {
  if (!onIdle || idleTimer) return
  idleTimer = setTimeout(() => {
    idleTimer = undefined
    onIdle?.()
  }, 0)
  idleTimer.unref()
}

export function trackMcpSenses(senses: Sense<ZodType>[], lifetime: McpLifetime): void {
  for (const sense of senses) {
    const execute = sense.executor.execute
    sense.executor = {
      ...sense.executor,
      async execute(...args) {
        if (lifetime.suspended || lifetime.closed)
          throw new Error('MCP 连接正在安全切换，请等待配置生效后重试')
        lifetime.calls++
        const release = trackRestartActivity({
          kind: 'mcp',
          description: `等待 MCP ${lifetime.handle.name} 调用完成`,
        })
        try {
          return await execute(...args)
        } finally {
          lifetime.calls--
          release()
          void lifetime.collect()
          notifyIdle()
        }
      },
    }
    executors.set(sense.executor, lifetime)
  }
}

export function retainMcpExecutors(
  values: Iterable<object>,
  owner: McpOwner,
  treeOwned = false,
): () => void {
  const lifetimes = new Set([...values].map((value) => executors.get(value)))
  const releases = [...lifetimes].flatMap((entry) =>
    entry ? [entry.retain(owner, treeOwned)] : [],
  )
  return () => releases.forEach((release) => release())
}

export function bindMcpExecutor(source: object, target: object): void {
  const lifetime = executors.get(source)
  if (lifetime) executors.set(target, lifetime)
}

export async function collectRetiredMcpClients(): Promise<void> {
  await Promise.all([...retired].map((entry) => entry.collect()))
}

export function hasRetiredMcpProcess(name: string, except?: McpLifetime): boolean {
  return [...retired].some(
    (entry) => entry !== except && entry.exclusive && entry.handle.name === name && !entry.closed,
  )
}
