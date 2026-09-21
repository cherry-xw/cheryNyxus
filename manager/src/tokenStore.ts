/**
 * Manager 管理密钥的持久化与轮换。
 *
 * 设计目标（见 docs/guides/backend-runtime.md）：
 * - 密钥持久化到 .chery/manager-token.json（0600），重启后保持稳定，收藏的访问 URL 不失效；
 * - 超过 ROTATE_AFTER_MS（默认 7 天）后下次启动时惰性轮换新密钥，旧密钥进入 previous；
 * - previous 旧密钥在 GRACE_MS（默认 24 小时）内仍视为有效（读取/续期），控制操作仍要求当前密钥；
 * - 显式配置（CHERY_MANAGER_TOKEN 环境变量）优先，且不落盘、不轮换。
 */
import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const TOKEN_ROTATE_AFTER_MS = 7 * 24 * 60 * 60 * 1000
export const TOKEN_GRACE_MS = 24 * 60 * 60 * 1000

export interface ManagerTokenState {
  token: string
  createdAt: string
  previous: { token: string; rotatedAt: string } | null
}

/**
 * 读取或创建管理密钥（同步，仅启动期调用一次）。
 * - explicitToken 提供时直接使用，不读写文件；
 * - 文件缺失或损坏 → 生成新密钥并落盘；
 * - 文件存在且未超过轮换周期 → 原样复用（重启稳定）；
 * - 超过轮换周期 → 轮换：旧密钥移入 previous（宽限期内仍可用），生成新密钥并落盘。
 */
export function loadOrCreateToken(file: string, explicitToken?: string): ManagerTokenState {
  if (explicitToken) {
    return { token: explicitToken, createdAt: new Date().toISOString(), previous: null }
  }
  const existing = readTokenFile(file)
  if (existing) {
    const age = Date.now() - new Date(existing.createdAt).getTime()
    if (Number.isFinite(age) && age >= 0 && age < TOKEN_ROTATE_AFTER_MS) return existing
    const rotated: ManagerTokenState = {
      token: randomBytes(24).toString('base64url'),
      createdAt: new Date().toISOString(),
      previous: { token: existing.token, rotatedAt: new Date().toISOString() },
    }
    writeTokenFile(file, rotated)
    return rotated
  }
  const created: ManagerTokenState = {
    token: randomBytes(24).toString('base64url'),
    createdAt: new Date().toISOString(),
    previous: null,
  }
  writeTokenFile(file, created)
  return created
}

/** 当前密钥或其 previous 旧密钥（宽限期内）是否有效。 */
export function isTokenValid(
  state: ManagerTokenState,
  token: string | undefined,
  now = Date.now(),
): boolean {
  if (!token) return false
  if (token === state.token) return true
  if (state.previous && token === state.previous.token) {
    return now - new Date(state.previous.rotatedAt).getTime() < TOKEN_GRACE_MS
  }
  return false
}

function readTokenFile(file: string): ManagerTokenState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<ManagerTokenState>
    if (
      typeof parsed.token !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      (parsed.previous !== null &&
        (typeof parsed.previous !== 'object' ||
          parsed.previous === null ||
          typeof parsed.previous.token !== 'string' ||
          typeof parsed.previous.rotatedAt !== 'string'))
    ) {
      return undefined
    }
    return parsed as ManagerTokenState
  } catch {
    return undefined
  }
}

function writeTokenFile(file: string, state: ManagerTokenState): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(temporary, 0o600)
  renameSync(temporary, file)
  if (process.platform !== 'win32') chmodSync(file, 0o600)
}
