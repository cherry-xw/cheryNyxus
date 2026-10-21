import { connect } from 'node:net'
import { validateEncryptedTransport } from './encryptedTransport.js'
import { renderRatholeServerConfig, writePrivateRatholeConfig, type RatholeServerConfig } from './rathole.js'
import type { RelayAccepted } from '@chery/protocol/relay'

export async function confirmPrivateListeners(snapshot: RatholeServerConfig): Promise<void> {
  // rathole creates private service listeners after the client authenticates, not before accepted.
  const colon = snapshot.bindAddr.lastIndexOf(':')
  const rawHost = snapshot.bindAddr.slice(0, colon).replace(/^\[|\]$/g, '')
  const host = rawHost === '0.0.0.0' || rawHost === '::' ? '127.0.0.1' : rawHost
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port: Number(snapshot.bindAddr.slice(colon + 1)) })
    socket.setTimeout(1000)
    socket.once('connect', () => { socket.destroy(); resolve() })
    socket.once('timeout', () => { socket.destroy(); reject(new Error('Rathole control listener unavailable')) })
    socket.once('error', reject)
  })
}

export async function verifyPrivateListeners(snapshot: RatholeServerConfig): Promise<void> {
  for (const service of snapshot.services) {
    const colon = service.bindAddr.lastIndexOf(':'); const host = service.bindAddr.slice(0, colon).replace(/^\[|\]$/g, ''); const port = Number(service.bindAddr.slice(colon + 1))
    let failure: unknown
    for (let attempt = 0; attempt < 20; attempt++) {
      try { await new Promise<void>((resolve, reject) => { const socket = connect({ host, port }); socket.setTimeout(500); socket.once('connect', () => { socket.destroy(); resolve() }); socket.once('timeout', () => { socket.destroy(); reject(new Error('Listener timeout')) }); socket.once('error', reject) }); failure = undefined; break } catch (error) { failure = error; await new Promise((resolve) => setTimeout(resolve, 100)) }
    }
    if (failure) throw new Error('Rathole snapshot listeners not confirmed')
  }
}

async function confirmListenerReleased(address: string): Promise<void> {
  const colon = address.lastIndexOf(':'); const host = address.slice(0, colon).replace(/^\[|\]$/g, ''); const port = Number(address.slice(colon + 1))
  for (let attempt = 0; attempt < 50; attempt++) {
    const released = await new Promise<boolean>((resolve) => {
      const socket = connect({ host, port }); socket.setTimeout(300)
      socket.once('connect', () => { socket.destroy(); resolve(false) })
      socket.once('timeout', () => { socket.destroy(); resolve(false) })
      socket.once('error', (error: NodeJS.ErrnoException) => { socket.destroy(); resolve(error.code === 'ECONNREFUSED') })
    })
    if (released) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Removed tunnel listener not released; ports remain reserved')
}

/** Serial global snapshots; applying one lease never overwrites another lease. */
export class RatholeLeaseManager {
  private leases = new Map<string, RelayAccepted>()
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly file: string, private readonly bindAddr: string, private readonly apply: (snapshot: RatholeServerConfig) => Promise<void>, private readonly encryptedTransport: string) {
    this.encryptedTransport = validateEncryptedTransport(encryptedTransport, 'server')
  }
  initialize(): Promise<void> { return this.serial(async () => { this.leases.clear(); await this.publish(this.leases, false) }) }
  add(lease: RelayAccepted): Promise<void> {
    return this.serial(async () => {
      const next = new Map(this.leases); next.set(lease.leaseId, structuredClone(lease))
      try { await this.publish(next); this.leases = next } catch (error) { await this.publish(this.leases); throw error }
    })
  }
  remove(leaseId: string): Promise<void> {
    return this.serial(async () => {
      const removed = this.leases.get(leaseId)
      const next = new Map(this.leases); next.delete(leaseId)
      await this.publish(next)
      if (removed) for (const address of [removed.tunnel.httpBindAddr!, removed.tunnel.websocketBindAddr!]) await confirmListenerReleased(address)
      this.leases = next
    })
  }
  private async publish(leases: Map<string, RelayAccepted>, confirm = true): Promise<void> {
    const snapshot: RatholeServerConfig = { bindAddr: this.bindAddr, services: [...leases.values()].flatMap((v) => [{ name: v.tunnel.httpService, token: v.tunnel.token, bindAddr: v.tunnel.httpBindAddr! }, { name: v.tunnel.websocketService, token: v.tunnel.token, bindAddr: v.tunnel.websocketBindAddr! }]) }
    await writePrivateRatholeConfig(this.file, renderRatholeServerConfig(snapshot) + this.encryptedTransport)
    if (confirm) await this.apply(snapshot)
  }
  private serial(work: () => Promise<void>): Promise<void> { const result = this.queue.then(work); this.queue = result.catch(() => {}); return result }
}
