import { xorEncrypt } from '../../src/utils/obfuscate.js'

export type VerifyStatus = 'verified' | 'stale' | 'unreachable'

export interface VerifyLoginResult {
  status: VerifyStatus
  attempts: number
}

export interface VerifyLoginOptions {
  /** 最多尝试次数（等待后端配置自动重载）。 */
  attempts?: number
  /** 每两次尝试之间的等待毫秒数。 */
  delayMs?: number
  /** 单次请求的超时毫秒数。 */
  timeoutMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

type AttemptResult = 'verified' | 'denied' | 'error'

/**
 * 单次登录自检：复用与前端相同的「challenge → nonce 派生密钥加密 → login」协议，
 * 新凭据能换到 200 即视为已生效。
 */
async function attemptOnce(
  base: string,
  username: string,
  password: string,
  timeoutMs: number,
): Promise<AttemptResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let challenge: Response
    try {
      challenge = await fetch(`${base}/api/auth/challenge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username }),
        signal: controller.signal,
      })
    } catch {
      return 'error'
    }
    // 认证未启用 / 账号锁定 / 后端未就绪等，一律视为「尚未确认」。
    if (!challenge.ok) return 'denied'
    const body = (await challenge.json().catch(() => null)) as {
      challengeId?: string
      nonce?: string
    } | null
    if (!body?.challengeId || !body?.nonce) return 'denied'
    const cipher = xorEncrypt(body.nonce, JSON.stringify({ username, password }))
    let login: Response
    try {
      login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeId: body.challengeId, cipher }),
        signal: controller.signal,
      })
    } catch {
      return 'error'
    }
    return login.ok ? 'verified' : 'denied'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 轮换后验证新凭据是否已在后端生效。
 * 后端配置监听器通常在 1 秒内自动重载，因此按间隔重试；
 * 只要曾收到过后端 HTTP 响应但未验证成功 → stale（后端尚未生效），
 * 全程连接失败 → unreachable（后端不可达）。
 */
export async function verifyLogin(
  base: string,
  username: string,
  password: string,
  options: VerifyLoginOptions = {},
): Promise<VerifyLoginResult> {
  const attempts = options.attempts ?? 5
  const delayMs = options.delayMs ?? 500
  const timeoutMs = options.timeoutMs ?? 1500
  let sawHttpResponse = false
  for (let i = 0; i < attempts; i++) {
    const result = await attemptOnce(base, username, password, timeoutMs)
    if (result === 'verified') return { status: 'verified', attempts: i + 1 }
    if (result === 'denied') sawHttpResponse = true
    if (i < attempts - 1) await sleep(delayMs)
  }
  return { status: sawHttpResponse ? 'stale' : 'unreachable', attempts }
}
