import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import yaml from 'js-yaml'
import { hashPassword, isHashed } from '../../src/utils/password.js'

export interface ManagerCredentialView {
  username: string
  password?: string
  consistent: boolean
  source: 'file' | 'missing'
  updatedAt?: string
}

interface StoredCredentials {
  version: 1
  username: string
  password: string
  passwordHash: string
  updatedAt: string
}

export interface CredentialStoreOptions {
  configFile: string
  credentialsFile: string
}

export class CredentialStore {
  constructor(private readonly options: CredentialStoreOptions) {}

  async view(): Promise<ManagerCredentialView> {
    const stored = await this.readStored()
    if (!stored) return { username: '', consistent: false, source: 'missing' }
    const auth = readAuth(await this.readConfig())
    return {
      username: stored.username,
      password: stored.password,
      consistent: auth?.username === stored.username && auth.password === stored.passwordHash,
      source: 'file',
      updatedAt: stored.updatedAt,
    }
  }

  async status(): Promise<ManagerCredentialView> {
    const view = await this.view()
    if (view.source === 'file') return view
    const auth = readAuth(await this.readConfig())
    return {
      username: auth?.username ?? '',
      consistent: Boolean(auth?.username && auth.password && isHashed(auth.password)),
      source: 'missing',
    }
  }

  async rotate(input: { username?: string; password?: string }): Promise<ManagerCredentialView> {
    const previous = await this.readStored()
    const config = await this.readConfig()
    const currentAuth = readAuth(config)
    const username = input.username?.trim() || previous?.username || currentAuth?.username || 'nyxus'
    const password = input.password?.trim() || randomPassword()
    if (!username || !password) throw new Error('username and password are required')
    const passwordHash = hashPassword(password)
    const updatedAt = new Date().toISOString()
    const next: StoredCredentials = { version: 1, username, password, passwordHash, updatedAt }

    const nextConfig = isRecord(config) ? structuredClone(config) : {}
    const server = isRecord(nextConfig.server) ? nextConfig.server : {}
    const auth = isRecord(server.auth) ? server.auth : {}
    nextConfig.server = server
    server.auth = auth
    auth.enabled = true
    auth.username = username
    auth.password = passwordHash

    await writeProtectedJson(this.options.credentialsFile, next)
    await writeYaml(this.options.configFile, nextConfig)
    return { username, password, consistent: true, source: 'file', updatedAt }
  }

  private async readStored(): Promise<StoredCredentials | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.options.credentialsFile, 'utf8')) as Partial<StoredCredentials>
      if (
        parsed.version !== 1 ||
        typeof parsed.username !== 'string' ||
        typeof parsed.password !== 'string' ||
        typeof parsed.passwordHash !== 'string' ||
        typeof parsed.updatedAt !== 'string'
      ) return undefined
      return parsed as StoredCredentials
    } catch {
      return undefined
    }
  }

  private async readConfig(): Promise<Record<string, unknown>> {
    try {
      const parsed = yaml.load(await readFile(this.options.configFile, 'utf8'))
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }
}

function readAuth(config: Record<string, unknown>): { username?: string; password?: string } | undefined {
  const server = isRecord(config.server) ? config.server : undefined
  const auth = server && isRecord(server.auth) ? server.auth : undefined
  if (!auth) return undefined
  return {
    ...(typeof auth.username === 'string' ? { username: auth.username } : {}),
    ...(typeof auth.password === 'string' ? { password: auth.password } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function randomPassword(): string {
  return [randomBytes(9), randomBytes(9), randomBytes(9)]
    .map((part) => part.toString('base64url'))
    .join('-')
}

async function writeProtectedJson(file: string, value: StoredCredentials): Promise<void> {
  await writeProtected(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function writeYaml(file: string, value: Record<string, unknown>): Promise<void> {
  await writeProtected(file, yaml.dump(value, { lineWidth: -1 }))
}

async function writeProtected(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  await writeFile(temporary, contents, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(temporary, 0o600)
  await rename(temporary, file)
  if (process.platform !== 'win32') await chmod(file, 0o600)
}
