import { mkdir, open, rename, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import type { RelayAccepted, RelayTunnelAddresses } from '@chery/protocol/relay'

export interface RatholeService {
  name: string
  token: string
  localAddr: string
  bindAddr: string
}

export interface RatholeClientConfig {
  serverAddr: string
  services: RatholeService[]
}

export function assertPrivateRatholeServices(services: RatholeService[]): void {
  if (services.length !== 2) throw new Error('rathole must contain exactly two CheryNyxus services')
  const names = new Set(services.map((service) => service.name))
  if (names.size !== 2 || [...names].some((name) => !/^[A-Za-z0-9_-]{1,80}$/.test(name))) {
    throw new Error('rathole services must contain two unique safe names')
  }
  for (const service of services) {
    if (!service.token || service.token.length < 16) throw new Error(`rathole token is invalid for ${service.name}`)
    if (!isLoopbackAddress(service.localAddr)) throw new Error(`rathole local address must be loopback for ${service.name}`)
    if (!isLoopbackAddress(service.bindAddr)) throw new Error(`rathole bind address must be loopback for ${service.name}`)
    if (portOf(service.localAddr) === 39980 || portOf(service.bindAddr) === 39980) {
      throw new Error('rathole must not expose the manager port')
    }
  }
}

export interface RatholeServerConfig {
  bindAddr: string
  services: Array<Pick<RatholeService, 'name' | 'token' | 'bindAddr'>>
}

/**
 * Rathole uses TOML. Only the two explicit service entries are emitted so a
 * generated file cannot accidentally become a generic port forwarder.
 */
export function renderRatholeClientConfig(config: RatholeClientConfig): string {
  assertPrivateRatholeServices(config.services)
  const lines = [`[client]`, `remote_addr = ${toml(config.serverAddr)}`, '']
  for (const service of config.services) {
    lines.push(
      `[client.services.${service.name}]`,
      `token = ${toml(service.token)}`,
      `local_addr = ${toml(service.localAddr)}`,
      '',
    )
  }
  return `${lines.join('\n')}\n`
}

export function renderRatholeServerConfig(config: RatholeServerConfig): string {
    for (const service of config.services) {
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(service.name) || service.token.length < 16 || !isLoopbackAddress(service.bindAddr) || portOf(service.bindAddr) === 39980) throw new Error('Invalid private rathole service')
    }
    if (new Set(config.services.map((s) => s.name)).size !== config.services.length || new Set(config.services.map((s) => s.bindAddr)).size !== config.services.length || config.services.length % 2 !== 0) throw new Error('Invalid global rathole snapshot')
  const lines = [`[server]`, `bind_addr = ${toml(config.bindAddr)}`, '']
  if (!config.services.length) lines.push('[server.services]', '')
  for (const service of config.services) {
    lines.push(
      `[server.services.${service.name}]`,
      `token = ${toml(service.token)}`,
      `bind_addr = ${toml(service.bindAddr)}`,
      '',
    )
  }
  return `${lines.join('\n')}\n`
}

export async function writePrivateRatholeConfig(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  try {
    const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { const stat = await existing.stat(); if (!stat.isFile() || (process.platform !== 'win32' && stat.uid !== process.getuid?.())) throw new Error('Tunnel configuration must be an owned regular file') } finally { await existing.close() }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try { await handle.writeFile(contents); await handle.sync() } finally { await handle.close() }
    await rename(temporary, path)
  } finally { await rm(temporary, { force: true }) }
}

export function createPrivateServices(input: {
  httpLocalAddr: string
  wsLocalAddr: string
  httpBindAddr: string
  wsBindAddr: string
}): RatholeService[] {
  const token = randomBytes(32).toString('base64url')
  const services = [
    {
      name: 'chery_http',
      token,
      localAddr: input.httpLocalAddr,
      bindAddr: input.httpBindAddr,
    },
    {
      name: 'chery_ws',
      token,
      localAddr: input.wsLocalAddr,
      bindAddr: input.wsBindAddr,
    },
  ]
  assertPrivateRatholeServices(services)
  return services
}

export function servicesFromAccepted(input: {
  accepted: Pick<RelayAccepted, 'tunnel'>
  addresses: RelayTunnelAddresses
  bindAddresses: { httpBindAddr: string; wsBindAddr: string }
}): RatholeService[] {
  const accepted = input.accepted.tunnel
  const services = [
    {
      name: input.accepted.tunnel.httpService,
      token: input.accepted.tunnel.token,
      localAddr: input.addresses.httpLocalAddr,
      bindAddr: accepted.httpBindAddr ?? input.bindAddresses.httpBindAddr,
    },
    {
      name: input.accepted.tunnel.websocketService,
      token: input.accepted.tunnel.token,
      localAddr: input.addresses.websocketLocalAddr,
      bindAddr: accepted.websocketBindAddr ?? input.bindAddresses.wsBindAddr,
    },
  ]
  if (!services.every((service) => /^[A-Za-z0-9_-]{1,80}$/.test(service.name))) {
    throw new Error('rathole service name is invalid')
  }
  if (new Set(services.map((service) => service.name)).size !== 2) {
    throw new Error('rathole service names must be unique')
  }
  for (const service of services) {
    if (!service.token || service.token.length < 16) throw new Error('rathole token is invalid')
    if (!isLoopbackAddress(service.localAddr) || !isLoopbackAddress(service.bindAddr)) {
      throw new Error('rathole tunnel addresses must be loopback')
    }
  }
  assertPrivateRatholeServices(services)
  return services
}

export interface RatholeProcess {
  process: ChildProcess
  stop: () => Promise<void>
}

export type RatholeProcessFactory = (binary: string, configPath: string) => RatholeProcess

export function startRathole(binary: string, configPath: string, env?: NodeJS.ProcessEnv): RatholeProcess {
  const child = spawn(binary, [configPath], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
    if (child.stdout) child.stdout.resume()
    if (child.stderr) child.stderr.resume()
    child.on('error', () => {})
    return {
    process: child,
    stop: async () => {
      if (child.exitCode !== null) return
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
          resolve()
        }, 5_000)
        child.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
    },
  }
}

function isLoopbackAddress(value: string): boolean {
  const host = value.slice(0, value.lastIndexOf(':'))
  return portOf(value) !== undefined && (host === '127.0.0.1' || host === '[::1]' || host === '::1')
}

function portOf(value: string): number | undefined {
  const raw = value.slice(value.lastIndexOf(':') + 1)
  const port = Number(raw)
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined
}

function toml(value: string): string {
  return JSON.stringify(value)
}
