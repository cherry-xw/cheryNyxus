import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'

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

export interface RatholeServerConfig {
  bindAddr: string
  services: Array<Pick<RatholeService, 'name' | 'token' | 'bindAddr'>>
}

/**
 * Rathole uses TOML. Only the two explicit service entries are emitted so a
 * generated file cannot accidentally become a generic port forwarder.
 */
export function renderRatholeClientConfig(config: RatholeClientConfig): string {
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
  const lines = [`[server]`, `bind_addr = ${toml(config.bindAddr)}`, '']
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
  await writeFile(path, contents, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

export function createPrivateServices(input: {
  httpLocalAddr: string
  wsLocalAddr: string
  httpBindAddr: string
  wsBindAddr: string
}): RatholeService[] {
  return [
    {
      name: 'chery_http',
      token: randomBytes(32).toString('base64url'),
      localAddr: input.httpLocalAddr,
      bindAddr: input.httpBindAddr,
    },
    {
      name: 'chery_ws',
      token: randomBytes(32).toString('base64url'),
      localAddr: input.wsLocalAddr,
      bindAddr: input.wsBindAddr,
    },
  ]
}

export interface RatholeProcess {
  process: ChildProcess
  stop: () => Promise<void>
}

export function startRathole(binary: string, configPath: string, env?: NodeJS.ProcessEnv): RatholeProcess {
  const child = spawn(binary, ['--config', configPath], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
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

function toml(value: string): string {
  return JSON.stringify(value)
}
