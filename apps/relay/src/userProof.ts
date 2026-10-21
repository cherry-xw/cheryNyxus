import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto'
import { UserProofClaimsSchema, UserProofHeaderSchema, type UserProofClaims } from '@chery/protocol'

export function proofRequestHash(method: string, path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20]/.test(path)) throw new Error('Invalid proof path')
  return createHash('sha256').update(`${method.toUpperCase()}\n${path}`).digest('base64url')
}
export class UserProofSigner {
  private readonly key: ReturnType<typeof createPrivateKey>
  constructor(private readonly issuer: string, private readonly kid: string, privateKeyPem: string) {
    this.key = createPrivateKey(privateKeyPem)
    if (this.key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 key required')
    UserProofHeaderSchema.parse({ alg: 'EdDSA', typ: 'JWT', kid })
  }
  issue(input: Omit<UserProofClaims, 'iss' | 'iat' | 'nbf' | 'exp' | 'jti' | 'requestHash'>, method: string, path: string, now = Math.floor(Date.now() / 1000)): string {
    const claims = UserProofClaimsSchema.parse({ ...input, iss: this.issuer, iat: now, nbf: now, exp: now + 60, jti: randomBytes(24).toString('base64url'), requestHash: proofRequestHash(method, path) })
    const header = encode({ alg: 'EdDSA', typ: 'JWT', kid: this.kid })
    const payload = encode(claims)
    const bytes = `${header}.${payload}`
    return `${bytes}.${sign(null, Buffer.from(bytes), this.key).toString('base64url')}`
  }
}
/** Trust is deployment supplied; token headers can never choose a URL or algorithm. */
export class UserProofVerifier {
  private readonly keys = new Map<string, ReturnType<typeof createPublicKey>>()
  private readonly consumed = new Map<string, number>()
  constructor(private readonly issuer: string, private readonly backendId: string, keys: Record<string, string>, private readonly authorized: (claims: UserProofClaims) => boolean, private readonly capacity = 10000) {
    for (const [kid, pem] of Object.entries(keys)) {
      const key = createPublicKey(pem)
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 key required')
      this.keys.set(kid, key)
    }
  }
  consume(token: string, method: string, path: string, now = Math.floor(Date.now() / 1000)): UserProofClaims {
    for (const [id, expiry] of this.consumed) if (expiry <= now) this.consumed.delete(id)
    if (token.length > 8192) throw new Error('USER_PROOF_INVALID')
    const parts = token.split('.')
    if (parts.length !== 3 || parts.some((s) => !/^[A-Za-z0-9_-]+$/.test(s))) throw new Error('USER_PROOF_INVALID')
    const [head, body, signature] = parts as [string, string, string]
    const header = UserProofHeaderSchema.parse(decode(head))
    const key = this.keys.get(header.kid)
    if (!key || !verify(null, Buffer.from(`${head}.${body}`), key, Buffer.from(signature, 'base64url'))) throw new Error('USER_PROOF_INVALID')
    const claims = UserProofClaimsSchema.parse(decode(body))
    if (claims.iss !== this.issuer || claims.aud !== this.backendId || claims.exp <= now || claims.nbf > now + 5 || claims.iat > now + 5 || claims.requestHash !== proofRequestHash(method, path)) throw new Error('USER_PROOF_INVALID')
    if (this.consumed.has(claims.jti) || this.consumed.size >= this.capacity || !this.authorized(claims)) throw new Error('USER_PROOF_INVALID')
    this.consumed.set(claims.jti, claims.exp)
    return claims
  }
}
function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url') }
function decode(value: string): unknown {
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new Error('USER_PROOF_INVALID')
  return JSON.parse(bytes.toString('utf8'))
}
