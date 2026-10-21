import { chmod, link, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import yaml from 'js-yaml'
import { withConfigTransaction, replaceConfigText, transactionExpectedText } from '../../backend/src/utils/configTransaction.js'
import { hashPassword, isHashed, verifyPassword } from '../../backend/src/utils/password.js'

export interface ManagerCredentialView {
  username: string
  consistent: boolean
  source: 'file' | 'missing' | 'unavailable'
  reason?: 'credentials_missing' | 'credentials_inconsistent' | 'credentials_unreadable'
  updatedAt?: string
}

interface StoredCredentials {
  version: 2
  username: string
  passwordHash: string
  passwordCipher: string
  updatedAt: string
}

export interface RotatedCredentials {
  credentials: ManagerCredentialView
  password: string
}

export interface CredentialStoreOptions {
  configFile: string
  credentialsFile: string
  /** Reserved caller option; current credentials always use the independent key file. */
  encryptionKey?: string
}

export class CredentialStore {
  constructor(private readonly options: CredentialStoreOptions) {}

  /** Provision the internal management identity once, never a browser login step. */
  async ensureInternal(): Promise<void> {
    return this.withLock(async () => {
      const stored = await this.readStored()
      if (stored) {
        await this.decryptStored(stored)
        if ((await this.viewStored(stored)).consistent) return
        throw new Error('内部管理凭据不一致，拒绝自动覆盖已有凭据')
      }
      await withConfigTransaction(this.options.configFile, async () => {
        const auth = readAuth(await this.readConfig())
        if (auth?.username || auth?.password) throw new Error('已有后端认证需要部署迁移，拒绝覆盖')
        await this.rotateUnlocked({ username: 'manager-internal' })
      })
    })
  }

  async view(): Promise<ManagerCredentialView> {
    return this.withLock(async () => this.viewStored(await this.readStored()))
  }

  async status(): Promise<ManagerCredentialView> {
    try {
      const view = await this.viewStored(await this.readStored())
      return { ...view, ...(view.consistent ? {} : {
        reason: view.source === 'missing' ? 'credentials_missing' as const : 'credentials_inconsistent' as const,
      }) }
    } catch {
      return { username: '', consistent: false, source: 'unavailable', reason: 'credentials_unreadable' }
    }
  }

  async auth(): Promise<{ username: string; password?: string; consistent?: boolean }> {
    return this.withLock(async () => {
      const stored = await this.readStored()
      if (!stored) {
        return { username: '', consistent: false }
      }
      const password = await this.decryptStored(stored)
      const view = await this.viewStored(stored)
      return { username: stored.username, password, consistent: view.consistent }
    })
  }

  async rotate(input: { username?: string; password?: string }): Promise<RotatedCredentials> {
    return this.withLock(() => withConfigTransaction(this.options.configFile, () => this.rotateUnlocked(input)))
  }

  private async viewStored(stored?: StoredCredentials): Promise<ManagerCredentialView> {
    if (!stored) return { username: '', consistent: false, source: 'missing' }
    const auth = readAuth(await this.readConfig())
    return {
      username: stored.username,
      consistent: auth?.username === stored.username && auth.password === stored.passwordHash,
      source: 'file',
      updatedAt: stored.updatedAt,
    }
  }

  private async decryptStored(stored: StoredCredentials): Promise<string> {
    const password = decrypt(stored.passwordCipher, await this.readKey(false))
    if (password === undefined || !verifyPassword(password, stored.passwordHash)) {
      throw new Error('内部管理凭据无法验证，拒绝覆盖')
    }
    return password
  }

  private async rotateUnlocked(input: { username?: string; password?: string }): Promise<RotatedCredentials> {
    const previous = await this.readStored()
    if (previous) await this.decryptStored(previous)
    const config = await this.readConfig()
    const currentAuth = readAuth(config)
    const username = input.username?.trim() || previous?.username || currentAuth?.username || 'manager-internal'
    const password = input.password ?? randomPassword()
    if (!username || !password) throw new Error('username and password are required')
    const passwordHash = hashPassword(password)
    const updatedAt = new Date().toISOString()
    const next: StoredCredentials = {
      version: 2,
      username,
      passwordHash,
      passwordCipher: encrypt(password, await this.readKey(!previous)),
      updatedAt,
    }

    const nextConfig = structuredClone(config)
    const server = isRecord(nextConfig.server) ? nextConfig.server : {}
    const auth = isRecord(server.auth) ? server.auth : {}
    nextConfig.server = server
    server.auth = auth
    auth.machine = { username, password: passwordHash }

    await writeProtectedJson(this.options.credentialsFile, next)
    await writeYaml(this.options.configFile, nextConfig)
    return { credentials: { username, consistent: true, source: 'file', updatedAt }, password }
  }

  private async readStored(): Promise<StoredCredentials | undefined> {
    let contents: string
    try {
      contents = await readFile(this.options.credentialsFile, 'utf8')
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return undefined
      throw error
    }
    const parsed: unknown = JSON.parse(contents)
    if (!isRecord(parsed) || parsed.version !== 2 ||
      typeof parsed.username !== 'string' || typeof parsed.passwordHash !== 'string' ||
      typeof parsed.passwordCipher !== 'string' || typeof parsed.updatedAt !== 'string') {
      throw new Error('内部管理凭据格式无效，拒绝覆盖')
    }
    const stored: StoredCredentials = {
      version: parsed.version,
      username: parsed.username,
      passwordHash: parsed.passwordHash,
      passwordCipher: parsed.passwordCipher,
      updatedAt: parsed.updatedAt,
    }
    if (Object.keys(parsed).some((key) => !['version', 'username', 'passwordHash', 'passwordCipher', 'updatedAt'].includes(key)) ||
        !stored.username || !isHashed(stored.passwordHash) || !Number.isFinite(Date.parse(stored.updatedAt))) {
      throw new Error('内部管理凭据需要当前独立格式，拒绝迁移或覆盖')
    }
    // Existing ciphertext never creates a replacement key or rewrites data.
    await this.decryptStored(stored)
    return stored
  }

  private async readKey(create: boolean): Promise<Buffer> {
    const file = `${this.options.credentialsFile}.key`
    let handle
    try {
      handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
    } catch (error) {
      if (!create || !hasCode(error, 'ENOENT')) throw error
      // Atomically publish a fully written key, without replacing an existing key.
      const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
      try {
        const writer = await open(temporary, 'wx', 0o600)
        try {
          await writer.writeFile(randomBytes(32))
          await writer.sync()
        } finally {
          await writer.close()
        }
        await link(temporary, file)
        if (process.platform !== 'win32') {
          const directory = await open(dirname(file), constants.O_RDONLY)
          try {
            await directory.sync()
          } finally {
            await directory.close()
          }
        }
      } catch (publishError) {
        if (!hasCode(publishError, 'EEXIST')) throw publishError
      } finally {
        await rm(temporary, { force: true })
      }
      return this.readKey(false)
    }
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size !== 32 || (process.platform !== 'win32' &&
        ((info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()))) {
        throw new Error('内部管理密钥必须为当前用户所有的 0600 普通文件（32 字节）')
      }
      const key = await handle.readFile()
      if (key.length !== 32) throw new Error('内部管理密钥长度无效')
      return key
    } finally {
      await handle.close()
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    // Cross-instance/process serialization prevents migration clobbering rotation.
    const lock = `${resolve(this.options.credentialsFile)}.lock`
    await mkdir(dirname(lock), { recursive: true })
    const deadline = Date.now() + 5000
    for (;;) {
      try {
        await mkdir(lock, { mode: 0o700 })
        break
      } catch (error) {
        if (!hasCode(error, 'EEXIST')) throw error
        if (Date.now() >= deadline) throw new Error('内部管理凭据锁超时；请检查运行中或中断的写入')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    try {
      return await operation()
    } finally {
      await rm(lock, { recursive: true })
    }
  }

  private async readConfig(): Promise<Record<string, unknown>> {
    try {
      const parsed = yaml.load(await readFile(this.options.configFile, 'utf8'))
      if (parsed !== undefined && !isRecord(parsed)) throw new Error('Configuration root must be a mapping')
      return parsed ?? {}
    } catch (error) {
      if (hasCode(error, 'ENOENT')) return {}
      throw error
    }
  }
}

function readAuth(config: Record<string, unknown>): { username?: string; password?: string } | undefined {
  const server = isRecord(config.server) ? config.server : undefined
  const domain = server && isRecord(server.auth) ? server.auth : undefined
  const auth = domain && isRecord(domain.machine) ? domain.machine : undefined
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
  return randomBytes(12).toString('base64url')
}

async function writeProtectedJson(file: string, value: StoredCredentials): Promise<void> {
  await writeProtected(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function writeYaml(file: string, value: Record<string, unknown>): Promise<void> {
  const expected = transactionExpectedText(file)
  replaceConfigText(file, yaml.dump(value, { lineWidth: -1 }), expected)
}

async function writeProtected(file: string, contents: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: 'wx' })
    if (process.platform !== 'win32') await chmod(temporary, 0o600)
    await rename(temporary, file)
    if (process.platform !== 'win32') await chmod(file, 0o600)
  } finally {
    await rm(temporary, { force: true })
  }
}

function encrypt(value: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')
}

function decrypt(value: string, key: Buffer): string | undefined {
  try {
    const packed = Buffer.from(value, 'base64url')
    const decipher = createDecipheriv('aes-256-gcm', key, packed.subarray(0, 12))
    decipher.setAuthTag(packed.subarray(12, 28))
    return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}
