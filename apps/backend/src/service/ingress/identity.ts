import {
  immutableSnapshot,
  type IngressConnections,
  type IngressContext,
  type IngressIdentityHandle,
  type IngressRequestIdentity,
  type IngressRegistration,
} from './api.js'
import { ingressError } from './store.js'

type Channel = Parameters<IngressContext['identity']['registerChannel']>[0]
type Bind = Parameters<IngressContext['identity']['bind']>[0]
interface RecordIdentity extends Bind {
  ownerId: string
  generation: number
  connectionGeneration: number
  credentialKind: string
}
/** Authorization exists only in this host's WeakMap, never in a JSON projection. */
export class IngressIdentityAuthority {
  private handles = new WeakMap<IngressIdentityHandle, RecordIdentity>()
  private channels = new Map<string, { ownerId: string; definition: Channel }>()
  private generations = new Map<string, number>()
  private connectionGenerations = new Map<string, number>()
  constructor(
    private connections: IngressConnections,
    private isActive: (id: string) => boolean,
  ) {}
  register(owner: IngressRegistration, definition: Channel): () => void {
    if (
      !owner.grantedCapabilities.includes('channel.identity') ||
      !owner.channelGrants.some((grant) => grant.channel === definition.channel)
    )
      throw ingressError('CAPABILITY_DENIED')
    if (this.channels.has(definition.channel)) throw ingressError('REGISTRATION_CONFLICT')
    const item = { ownerId: owner.id, definition }
    this.channels.set(definition.channel, item)
    return () => {
      if (this.channels.get(definition.channel) === item) this.channels.delete(definition.channel)
      this.revoke(owner.id)
    }
  }
  revoke(owner: string): void {
    this.generations.set(owner, (this.generations.get(owner) ?? 0) + 1)
  }
  revokeConnection(connectionId: string): void {
    this.connectionGenerations.set(
      connectionId,
      (this.connectionGenerations.get(connectionId) ?? 0) + 1,
    )
  }
  async bind(owner: IngressRegistration, input: Bind): Promise<IngressIdentityHandle> {
    const channel = this.channels.get(input.channel)
    const credentialKind = this.connections.credentialKind(input.connectionId)
    const generation = this.generations.get(owner.id) ?? 0
    const connectionGeneration = this.connectionGenerations.get(input.connectionId) ?? 0
    const assert = () => {
      if (
        !this.isActive(owner.id) ||
        channel?.ownerId !== owner.id ||
        !this.connections.isOpen(input.connectionId) ||
        !credentialKind ||
        this.connections.credentialKind(input.connectionId) !== credentialKind ||
        !owner.channelGrants.some(
          (grant) => grant.channel === input.channel && grant.credentialKind === credentialKind,
        ) ||
        generation !== (this.generations.get(owner.id) ?? 0) ||
        connectionGeneration !== (this.connectionGenerations.get(input.connectionId) ?? 0)
      )
        throw ingressError('IDENTITY_REJECTED')
    }
    assert()
    const { subject } = input
    if (
      !subject?.selfId ||
      !subject.userId ||
      !input.eventId ||
      (subject.conversationType !== 'private' && subject.conversationType !== 'group') ||
      (subject.conversationType === 'group' ? !subject.groupId : subject.groupId !== undefined)
    )
      throw ingressError('IDENTITY_REJECTED')
    const connection = await channel!.definition.verifyConnection(
      Object.freeze({ connectionId: input.connectionId, credentialKind: credentialKind! }),
    )
    if (
      connection?.selfId !== subject.selfId ||
      !(await (input.purpose === 'source' ? channel!.definition.verifySource?.(immutableSnapshot(input)) : channel!.definition.verifyEvent(immutableSnapshot(input))))
    )
      throw ingressError('IDENTITY_REJECTED')
    assert()
    const handle = Object.freeze(Object.create(null)) as IngressIdentityHandle
    this.handles.set(handle, {
      ...immutableSnapshot(input),
      ownerId: owner.id,
      generation,
      connectionGeneration,
      credentialKind: credentialKind!,
    })
    return handle
  }
  validate(ownerId: string, entryId: string, handle: IngressIdentityHandle): RecordIdentity {
    const record = this.handles.get(handle)
    if (
      !record ||
      record.ownerId !== ownerId ||
      record.entryId !== entryId ||
      !this.isActive(ownerId) ||
      record.generation !== (this.generations.get(ownerId) ?? 0) ||
      record.connectionGeneration !== (this.connectionGenerations.get(record.connectionId) ?? 0) ||
      record.credentialKind !== this.connections.credentialKind(record.connectionId) ||
      !this.connections.isOpen(record.connectionId) ||
      this.channels.get(record.channel)?.ownerId !== ownerId
    )
      throw ingressError('IDENTITY_REJECTED')
    if (record.purpose === 'source' && !this.channels.get(record.channel)?.definition.validateSource?.(record)) throw ingressError('IDENTITY_REJECTED')
    return record
  }
  /** Execution keeps the accepted event authority across transport loss, not owner revocation. */
  validateExecution(ownerId: string, entryId: string, handle: IngressIdentityHandle): void {
    const record = this.handles.get(handle)
    if (!record || record.ownerId !== ownerId || record.entryId !== entryId ||
      !this.isActive(ownerId) || record.generation !== (this.generations.get(ownerId) ?? 0) ||
      this.channels.get(record.channel)?.ownerId !== ownerId)
      throw ingressError('IDENTITY_REJECTED')
  }
  project(
    ownerId: string,
    entryId: string,
    handle?: IngressIdentityHandle,
  ): IngressRequestIdentity {
    if (!handle) return Object.freeze({ source: 'plugin', ownerId, entryId })
    const record = this.validate(ownerId, entryId, handle)
    return immutableSnapshot({
      source: 'plugin',
      ownerId,
      entryId,
      channel: record.channel,
      subject: record.subject,
    })
  }
}
