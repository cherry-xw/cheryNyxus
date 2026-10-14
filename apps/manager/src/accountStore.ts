import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { replaceConfigText, transactionExpectedText, withConfigTransaction } from '../../backend/src/utils/configTransaction.js'

export interface ManagerAccount {
  version: 1
  username: string
  salt: string
  passwordHash: string
  revision: string
}

const parameters = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, Buffer.from(salt, 'hex'), 64, parameters, (error, key) =>
      error ? reject(error) : resolve(key),
    )
  })
}

export class AccountStore {
  constructor(readonly file: string) {}

  async read(): Promise<ManagerAccount | undefined> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Manager 账号文件不可读取')
    }
    try {
      const value = JSON.parse(text) as ManagerAccount
      if (value.version !== 1 || typeof value.username !== 'string' || !value.username ||
          !/^[a-f0-9]{32}$/.test(value.salt) || !/^[a-f0-9]{128}$/.test(value.passwordHash) ||
          !/^[a-f0-9]{64}$/.test(value.revision)) throw new Error()
      return value
    } catch {
      throw new Error('Manager 账号文件损坏，请使用本机 auth reset 恢复')
    }
  }

  async save(username: string, password: string, reset = false, expectedAccount?: ManagerAccount): Promise<void> {
    return withConfigTransaction(this.file, () => this.saveLocked(username, password, reset, expectedAccount))
  }

  private async saveLocked(username: string, password: string, reset: boolean, expectedAccount?: ManagerAccount): Promise<void> {
    const expectedText = transactionExpectedText(this.file)
    if (expectedAccount) {
      const current = await this.read()
      if (!current || current.revision !== expectedAccount.revision || current.passwordHash !== expectedAccount.passwordHash || current.salt !== expectedAccount.salt || current.username !== expectedAccount.username) {
        throw new Error('account_changed')
      }
    }
    if (!username || username !== username.trim() || username.length > 128 || /[\x00-\x1f]/.test(username)) {
      throw new Error('用户名须为 1–128 字符，不能含控制字符或首尾空白')
    }
    if (password.length < 12 || password.length > 1024) throw new Error('密码须为 12–1024 字符')
    if (!reset && await this.read()) throw new Error('账号已存在，请使用 auth reset')
    const salt = randomBytes(16).toString('hex')
    const account: ManagerAccount = {
      version: 1, username, salt,
      passwordHash: (await derive(password, salt)).toString('hex'),
      revision: randomBytes(32).toString('hex'),
    }
    await mkdir(dirname(this.file), { recursive: true })
    replaceConfigText(this.file, `${JSON.stringify(account)}\n`, expectedText)
  }

  async saveInitial(username: string, password: string): Promise<void> {
    const lock = `${this.file}.initial-setup-lock`
    await mkdir(dirname(lock), { recursive: true })
    let handle: Awaited<ReturnType<typeof open>> | undefined
    let owned = false
    try {
      handle = await open(lock, 'wx', 0o600)
      owned = true
      await this.save(username, password)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('账号初始化正在进行或已完成')
      throw error
    } finally {
      await handle?.close().catch(() => {})
      if (owned) try { await unlink(lock) } catch { /* 只清理本次锁文件。 */ }
    }
  }

  async verify(account: ManagerAccount, username: string, password: string): Promise<boolean> {
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024) return false
    const key = await derive(password, account.salt)
    const valid = timingSafeEqual(key, Buffer.from(account.passwordHash, 'hex'))
    return valid && username === account.username
  }
}
