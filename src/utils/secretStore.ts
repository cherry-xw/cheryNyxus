/**
 * 凭据池：AES-256-GCM 加密存储于 .chery/.secrets/git-credentials.json。
 *
 * 用途：为 git clone 私仓导入、其他需要 PAT/口令的场景集中保存敏感凭据；
 *       避免明文口令散落于 config.yaml / 日志 / RPC 响应中。
 *
 * 威胁模型（诚实声明）：
 *   - 主密钥派生自 .chery/.secret-key（32 字节随机）+ 主机名/用户名盐值（scrypt）。
 *   - 这是「混淆级」保护，**不是 OS keychain 级别**：任何能读 .chery/ 且能跑 node 的进程都能恢复明文。
 *   - 防护目标：偶然窥探、日志泄漏、配置文件误传；不防护本机恶意进程。
 *   - 真正的 secret 管理推荐 OS keychain（keytar）或外部 vault——见 docs/utils/secretStore.md。
 *
 * 边界：
 *   - getCredentialSecret 仅在后端进程内调用（gitClone 拿口令拼 Basic 头），**永不通过 RPC 返回**。
 *   - listCredentials 返回的列表项已剥除密文/iv/tag，只含元数据 + 用户名。
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname, userInfo } from 'node:os'

/** 凭据列表项（公开形态，密文已剥除）。 */
export interface CredentialListItem {
  id: string
  label: string
  username: string
  createdAt: string
}

/** 存储形态：列表项 + 加密信封。 */
interface StoredCredential extends CredentialListItem {
  ciphertext: string
  iv: string
  tag: string
}

/** 加密信封（encryptString 输出 / decryptString 输入）。 */
export interface EncryptedPayload {
  ciphertext: string
  iv: string
  tag: string
}

// 路径解析与 config.ts 同 idiom：CHERY_DIR || process.cwd()。
// 用 lazy 函数避免模块加载期固化（测试切临时目录、CHERY_DIR 运行期变化等场景）。
const getKeyFile = (): string =>
  join(process.env.CHERY_DIR || process.cwd(), '.chery', '.secret-key')
const getCredsFile = (): string =>
  join(process.env.CHERY_DIR || process.cwd(), '.chery', '.secrets', 'git-credentials.json')

/**
 * 主密钥：32 字节随机，落盘至 KEY_FILE（mode 0o600）。
 * 存在且长度正确则复用；否则生成新密钥。每次调用 chmodSync 重申权限（防止预存文件被改宽松）。
 */
function getMasterKey(): Buffer {
  const keyFile = getKeyFile()
  if (existsSync(keyFile)) {
    const buf = readFileSync(keyFile)
    if (buf.length === 32) return buf
    // 长度异常 → 视为损坏，走重新生成（旧密文将无法解密，调用方 getCredentialSecret 会捕获返回 undefined）
  }
  const key = randomBytes(32)
  mkdirSync(dirname(keyFile), { recursive: true })
  writeFileSync(keyFile, key, { mode: 0o600 })
  chmodSync(keyFile, 0o600)
  return key
}

/**
 * 派生密钥：scrypt(masterKey, salt, 32)。
 * salt = hostname|username——绑定本机本用户，复制 .secret-key 到其他主机/账户也无法解密。
 * userInfo() 在某些平台/异常账户下可能抛错，try/catch 兜底为 "user"。
 */
function deriveKey(): Buffer {
  let username = 'user'
  try {
    const info = userInfo()
    if (info.username) username = info.username
  } catch {
    // 兜底
  }
  const salt = `${hostname()}|${username}`
  return scryptSync(getMasterKey(), salt, 32)
}

/** AES-256-GCM 加密：返回 hex 编码的 ciphertext/iv(12B)/tag(16B)。 */
export function encryptString(plain: string): EncryptedPayload {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    ciphertext: enc.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
  }
}

/** AES-256-GCM 解密：GCM tag 校验失败（密钥错误/密文篡改）抛错，调用方需自行 try/catch。 */
export function decryptString(env: EncryptedPayload): string {
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), Buffer.from(env.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(env.tag, 'hex'))
  const dec = Buffer.concat([decipher.update(Buffer.from(env.ciphertext, 'hex')), decipher.final()])
  return dec.toString('utf8')
}

/** 读取全部凭据（存储形态）。文件缺失或 JSON 损坏 → 空数组（fail-soft，调用方据此判定无凭据）。 */
function loadAll(): StoredCredential[] {
  try {
    const credsFile = getCredsFile()
    if (!existsSync(credsFile)) return []
    const raw = readFileSync(credsFile, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as StoredCredential[]
  } catch {
    return []
  }
}

/** 原子写：tmp + rename + chmod。POSIX 上 rename 跨同 fs 原子；Windows 上若 target 存在会抛错（当前不处理）。 */
function saveAll(list: StoredCredential[]): void {
  const credsFile = getCredsFile()
  mkdirSync(dirname(credsFile), { recursive: true })
  const tmp = credsFile + '.tmp'
  writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 })
  renameSync(tmp, credsFile)
  chmodSync(credsFile, 0o600)
}

/** 剥除密文/iv/tag，仅暴露元数据 + 用户名。 */
function stripSecret(c: StoredCredential): CredentialListItem {
  return {
    id: c.id,
    label: c.label,
    username: c.username,
    createdAt: c.createdAt,
  }
}

/** 列出全部凭据（永不返回密文）。 */
export function listCredentials(): CredentialListItem[] {
  return loadAll().map(stripSecret)
}

/**
 * 按 id 解密取回原始口令。仅后端调用，**永不通过 RPC 返回**。
 * id 不存在或解密失败（密钥变更/密文损坏）→ 返回 undefined，调用方可据此提示「凭据不可用」。
 */
export function getCredentialSecret(id: string): string | undefined {
  const c = loadAll().find((item) => item.id === id)
  if (!c) return undefined
  try {
    return decryptString({ ciphertext: c.ciphertext, iv: c.iv, tag: c.tag })
  } catch {
    // 解密失败（主密钥变更/密文损坏）→ 视为不可用，调用方 surface "凭据不可用"
    return undefined
  }
}

/** 按 id 取 username（明文存储，无需解密）。供 handler 把 username 与解密后的 secret 配对。 */
export function getCredentialUsername(id: string): string | undefined {
  const c = loadAll().find((item) => item.id === id)
  return c?.username
}

/** 新增凭据：生成 UUID、加密口令、追加落盘。返回剥除密文的列表项。 */
export function saveCredential(input: {
  label: string
  username: string
  password: string
}): CredentialListItem {
  const enc = encryptString(input.password)
  const item: StoredCredential = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    label: input.label,
    username: input.username,
    ...enc,
  }
  const list = loadAll()
  list.push(item)
  saveAll(list)
  return stripSecret(item)
}

/** 按 id 删除凭据（不存在时静默无操作）。 */
export function deleteCredential(id: string): void {
  const list = loadAll().filter((item) => item.id !== id)
  saveAll(list)
}
