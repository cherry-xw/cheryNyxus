import { CONFIG_APPLY_VERSION, type ConfigApplyState, type ConfigImpact } from '@chery/protocol'
import {
  diffResources,
  imageRevision,
  resources,
  isTreeImpact,
  type ConfigImage,
  type ConfigResource,
} from './impact.js'

/** prepare must not publish runtime state or perform lifecycle effects. apply must be
 * an atomic synchronous swap; unsafe() is rechecked immediately before that swap. */
export interface ConfigApplyAdapter {
  prepare(input: {
    before: unknown
    after: unknown
    impact: ConfigImpact
    revision: string
  }): Promise<{
    unsafe(): string | undefined
    affectedRootChatIds?(): string[]
    apply(): void
    dispose(): void | Promise<void>
  }>
}

export type ConfigTreeAdapter = (input: {
  impacts: ConfigImpact[]
  target: ConfigImage
}) => ReturnType<ConfigApplyAdapter['prepare']>

export class ConfigApplyCoordinator {
  private applied: Map<string, ConfigResource>
  private latest: ConfigImage
  private appliedRevision: string
  private versions = new Map<string, string>()
  private results = new Map<string, ConfigImpact>()
  private adapters = new Map<string, ConfigApplyAdapter>()
  private running: Promise<void> | undefined
  private generation = 0
  private listeners = new Set<(state: ConfigApplyState) => void>()
  private treeAdapter?: ConfigTreeAdapter
  private forced = new Set<string>()
  private restartState?: ConfigApplyState['restart']
  private restartHandler?: (required: boolean) => void

  configureRestart(handler: (required: boolean) => void): void {
    this.restartHandler = handler
  }
  setRestartState(state: ConfigApplyState['restart']): void {
    this.restartState = structuredClone(state)
    this.publish()
  }
  isApplying(): boolean {
    return !!this.running
  }
  private requestRestart(): void {
    this.restartHandler?.(this.diff().some((impact) => impact.boundary === 'restart'))
  }

  requestResourceReload(resource: string): void {
    this.forced.add(resource)
    this.generation++
    this.results.delete(resource)
    this.requestRestart()
    this.publish()
  }

  private diff(target = resources(this.latest)): ConfigImpact[] {
    const before = new Map(this.applied)
    for (const resource of this.forced) before.delete(resource)
    return diffResources(before, target, this.appliedRevision)
  }

  constructor(initial: ConfigImage) {
    this.latest = structuredClone(initial)
    this.applied = resources(this.latest)
    this.appliedRevision = imageRevision(initial)
  }
  subscribe(listener: (state: ConfigApplyState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  register(resource: string, adapter: ConfigApplyAdapter): void {
    this.adapters.set(resource, adapter)
  }
  registerTreeAdapter(adapter: ConfigTreeAdapter): void {
    this.treeAdapter = adapter
  }
  getSavedImage(): ConfigImage {
    return structuredClone(this.latest)
  }
  getState(): ConfigApplyState {
    const impacts = this.diff().map((impact) => {
      const result = this.results.get(impact.resource)
      return {
        ...impact,
        ...result,
        appliedRevision: this.versions.get(impact.resource) ?? this.appliedRevision,
      }
    })
    // Include successful parts of a mixed submission, without claiming its whole revision is active.
    for (const [key, result] of this.results)
      if (!impacts.some((i) => i.resource === key)) impacts.push(result)
    const status = impacts.some((i) => i.status === 'failed')
      ? 'failed'
      : impacts.some((i) => i.status === 'pending')
        ? 'pending'
        : 'applied'
    return {
      protocolVersion: CONFIG_APPLY_VERSION,
      savedRevision: imageRevision(this.latest),
      appliedRevision: this.appliedRevision,
      status: this.restartState?.status === 'failed' ? 'failed' : status,
      impacts,
      restart: this.restartState ?? {
        required: impacts.some((i) => i.boundary === 'restart'),
        status: impacts.some((i) => i.boundary === 'restart') ? 'pending' : 'none',
      },
    }
  }
  submit(image: ConfigImage, failures: ConfigImpact[] = []): ConfigApplyState {
    this.latest = structuredClone(image)
    this.generation++
    this.results.clear()
    for (const failure of failures) this.results.set(failure.resource, structuredClone(failure))
    this.requestRestart()
    if (!diffResources(this.applied, resources(this.latest), this.appliedRevision).length)
      this.appliedRevision = imageRevision(this.latest)
    this.publish()
    // Saving is synchronous; preparation begins after the response state has been captured.
    void this.retry()
    return this.getState()
  }
  retry(): Promise<void> {
    if (this.running) return this.running
    this.running = Promise.resolve()
      .then(() => this.drain())
      .finally(() => {
        this.running = undefined
      })
    return this.running
  }
  private publish(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.getState())
      } catch {
        /* A disconnected output cannot invalidate a saved candidate. */
      }
    }
  }
  private async drain(): Promise<void> {
    let generation: number
    do {
      generation = this.generation
      const target = resources(structuredClone(this.latest))
      const revision = imageRevision(this.latest)
      const impacts = this.diff(target)
      const treeImpacts = impacts.filter(isTreeImpact)
      if (treeImpacts.length && this.treeAdapter) {
        let prepared: Awaited<ReturnType<ConfigApplyAdapter['prepare']>> | undefined
        try {
          prepared = await this.treeAdapter({
            impacts: structuredClone(treeImpacts),
            target: structuredClone(this.latest),
          })
          if (generation !== this.generation) continue
          const reason = prepared.unsafe()
          const affectedRootChatIds = prepared.affectedRootChatIds?.()
          if (reason) {
            for (const impact of treeImpacts)
              this.results.set(impact.resource, { ...impact, reason, affectedRootChatIds })
          } else {
            prepared.apply()
            for (const impact of treeImpacts) {
              const next = target.get(impact.resource)
              if (next) this.applied.set(impact.resource, next)
              else this.applied.delete(impact.resource)
              this.versions.set(impact.resource, revision)
              this.forced.delete(impact.resource)
              this.results.set(impact.resource, {
                ...impact,
                status: 'applied',
                reason: undefined,
                appliedRevision: revision,
                affectedRootChatIds,
              })
            }
          }
        } catch {
          if (generation === this.generation)
            for (const impact of treeImpacts)
              this.results.set(impact.resource, {
                ...impact,
                status: 'failed',
                reason: treeImpacts.some((item) => JSON.parse(item.resource)[0] === 'mcp_servers')
                  ? 'MCP 配置切换失败，保留旧配置；连接可用性请查看扩展工具状态后重试'
                  : '节点树配置切换失败，保留旧运行态，请重试',
              })
        } finally {
          try {
            await prepared?.dispose()
          } catch {
            if (generation === this.generation)
              for (const impact of treeImpacts)
                this.results.set(impact.resource, {
                  ...impact,
                  status: 'failed',
                  reason: '资源清理失败，请检查模块诊断后重试',
                })
          }
        }
        this.publish()
      }
      for (const impact of impacts) {
        if (generation !== this.generation) break // unstarted candidates are superseded
        if (isTreeImpact(impact) && this.treeAdapter) continue
        const adapter = this.adapters.get(impact.resource)
        if (!adapter || ['restart', 'unsupported'].includes(impact.boundary)) continue
        let prepared: Awaited<ReturnType<ConfigApplyAdapter['prepare']>> | undefined
        try {
          prepared = await adapter.prepare({
            before: structuredClone(this.applied.get(impact.resource)?.value),
            after: structuredClone(target.get(impact.resource)?.value),
            impact: structuredClone(impact),
            revision,
          })
          const reason = prepared.unsafe()
          if (reason) {
            if (generation === this.generation)
              this.results.set(impact.resource, { ...impact, reason: '等待资源安全边界' })
          } else {
            prepared.apply()
            const next = target.get(impact.resource)
            if (next) this.applied.set(impact.resource, next)
            else this.applied.delete(impact.resource)
            this.versions.set(impact.resource, revision)
            this.forced.delete(impact.resource)
            if (generation === this.generation)
              this.results.set(impact.resource, {
                ...impact,
                status: 'applied',
                reason: undefined,
                appliedRevision: revision,
              })
          }
        } catch {
          if (generation === this.generation)
            this.results.set(impact.resource, {
              ...impact,
              status: 'failed',
              reason: '资源准备或应用失败，保留最后可用运行态；请检查模块诊断',
            })
        } finally {
          try {
            await prepared?.dispose()
          } catch {
            if (generation === this.generation)
              this.results.set(impact.resource, {
                ...impact,
                status: 'failed',
                reason: '资源清理失败，请检查模块诊断',
              })
          }
        }
        this.publish()
      }
      if (!diffResources(this.applied, resources(this.latest), this.appliedRevision).length)
        this.appliedRevision = imageRevision(this.latest)
      this.publish()
    } while (generation !== this.generation)
  }
}
