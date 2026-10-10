import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

const COOKIE_NAME = 'chery_relay_session'

interface SessionPayload {
  backendId: string
  exp: number
  kind: 'password' | 'oidc'
  sessionId: string
  issuer?: string
  subject?: string
  bindingId?: string
}

function sign(encoded: string, secret: string): string {
  return createHmac('sha256', secret).update(encoded).digest('base64url')
}

export function createBackendSession(backendId: string, secret: string, ttlSeconds: number, extra: Partial<Omit<SessionPayload, 'backendId' | 'exp'>> = {}): string {
  const payload: SessionPayload = { backendId, exp: Math.floor(Date.now() / 1000) + ttlSeconds, kind: extra.kind ?? 'password', sessionId: extra.sessionId ?? randomUUID(), ...extra }
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${encoded}.${sign(encoded, secret)}`
}

export function readBackendSession(cookieHeader: string | undefined, secret: string): string | null {
  return readBackendSessionPayload(cookieHeader, secret)?.backendId ?? null
}

export function readBackendSessionPayload(cookieHeader: string | undefined, secret: string): SessionPayload | null {
  const raw = cookieHeader
    ?.split(/;\s*/)
    .find((part) => part.startsWith(`${COOKIE_NAME}=`))
    ?.slice(COOKIE_NAME.length + 1)
  if (!raw) return null
  const [encoded, signature, ...extra] = raw.split('.')
  if (!encoded || !signature || extra.length) return null
  const expected = sign(encoded, secret)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as SessionPayload
    return payload.exp > Math.floor(Date.now() / 1000) && typeof payload.backendId === 'string' && (payload.kind === 'password' || payload.kind === 'oidc')
      ? payload
      : null
  } catch {
    return null
  }
}

export function backendSessionCookie(input: {
  value: string
  basePath: string
  secure: boolean
  maxAge: number
}): string {
  const path = input.basePath ? `${input.basePath}/` : '/'
  return [
    `${COOKIE_NAME}=${input.value}`,
    `Path=${path}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${input.maxAge}`,
    ...(input.secure ? ['Secure'] : []),
  ].join('; ')
}
