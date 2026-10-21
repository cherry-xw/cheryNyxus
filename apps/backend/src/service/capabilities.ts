import { createHash, randomUUID } from 'node:crypto'
import { BOOTSTRAP_REQUIRED_CAPABILITIES, BOOTSTRAP_OPTIONAL_CAPABILITIES, BootstrapSchema, type Bootstrap, type BootstrapCapability } from '@chery/protocol'

/** Explicit public entrypoints only: internal canonical writes and agent tools are unaffected. */
export function methodCapability(method: string): BootstrapCapability | undefined {
  if (method.startsWith('terminal.')) return 'terminal.session'
  if (method.startsWith('workspace.')) return 'workspace.files'
  if (method.startsWith('task.') || method.startsWith('chat.overview')) return 'task.overview'
  if (method.startsWith('config.') || method.startsWith('hooks.') || method.startsWith('credentials.') || method.startsWith('env.') || method.startsWith('plugins.') || method.startsWith('skills.import') || method.startsWith('skills.commit') || method.startsWith('skills.delete') || method.startsWith('skills.source') || method.startsWith('prompts.') || method.startsWith('rules.') || method.startsWith('search.settings.') || method.startsWith('mcp.')) return 'settings.manage'
  if (method.startsWith('chat.taskUsage.') || method === 'chat.contextUsage' || method === 'chat.promptSnapshot' || method === 'chat.contextContent' || method === 'chat.epoch.list') return 'timeline.graph'
  if (method.startsWith('skills.') && !['skills.list', 'skills.listNames'].includes(method)) return 'settings.manage'
  if (method.startsWith('utils.') && !['utils.openFile', 'utils.editors'].includes(method)) return 'settings.manage'
  // chat.task.list/result.view and chat timeline readback are shared recovery dependencies.
  // chat.tree readback is a shared recovery dependency, not a graph-only feature.
  return undefined
}
export class BackendCapabilities {
  private readonly instanceId = randomUUID()
  private readonly active = new Set<BootstrapCapability>(BOOTSTRAP_REQUIRED_CAPABILITIES)
  constructor(readonly preset: 'basic' | 'full') {
    if (!['basic', 'full'].includes(preset)) throw new Error('Invalid business preset')
    if (preset === 'full') for (const capability of BOOTSTRAP_OPTIONAL_CAPABILITIES) this.active.add(capability)
  }
  disable(capability: BootstrapCapability): void {
    if ((BOOTSTRAP_REQUIRED_CAPABILITIES as readonly string[]).includes(capability)) throw new Error('Required service failed')
    this.active.delete(capability)
  }
  allows(method: string): boolean { const capability = methodCapability(method); return !capability || this.active.has(capability) }
  has(capability: BootstrapCapability): boolean { return this.active.has(capability) }
  snapshot(): Bootstrap {
    const capabilities = [...this.active].sort()
    return BootstrapSchema.parse({ protocolVersion: 1, instanceId: this.instanceId, revision: createHash('sha256').update(JSON.stringify([this.preset, capabilities])).digest('hex'), preset: this.preset, capabilities, software: { backend: { version: '1.0.0' } }, protocolRanges: { bootstrap: { min: 1, max: 1 }, relay: { min: 2, max: 2 }, websocket: { min: 1, max: 1 } } })
  }
}
