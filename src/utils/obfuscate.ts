/**
 * 轻量对称加解密（SHA-256 CTR 流密码，Node 实现）。
 *
 * 与前端 web/src/utils/obfuscate.ts、auth 登录信封（原 src/service/auth/index.ts xorDecrypt）
 * 严格一致：`keystream = SHA-256(keyHex_U8 || BE32(counter))` 逐块拼接，与明文逐字节异或。
 *
 * 安全边界：key（一次性 nonce）参与方可见，属**混淆级**——防被动嗅探/日志明文泄漏 + 防重放
 * （每请求新 nonce），不防主动中间人；真机密性依赖 HTTPS/loopback。
 */
import { createHash, randomBytes } from 'node:crypto'

/** 生成 byteLen 字节随机数（hex 字符串）。 */
export function randomHex(byteLen: number): string {
  return randomBytes(byteLen).toString('hex')
}

/** 生成 length 字节异或密钥流：SHA-256(keyHex_U8 || BE32(counter)) 逐块拼接（与 auth 旧实现字节级一致）。 */
function keystream(keyHex: string, length: number): Buffer {
  const key = Buffer.from(keyHex, 'utf8')
  const out = Buffer.alloc(length)
  let counter = 0
  let block = Buffer.alloc(0)
  let offset = 32
  for (let i = 0; i < length; i += 1) {
    if (offset >= block.length) {
      const count = Buffer.allocUnsafe(4)
      count.writeUInt32BE(counter, 0)
      counter += 1
      block = createHash('sha256').update(key).update(count).digest()
      offset = 0
    }
    out[i] = block[offset]!
    offset += 1
  }
  return out
}

/** 加密：明文 → base64 密文。keyHex 为任意 hex 串（传输 = 一次性 nonce）。 */
export function xorEncrypt(keyHex: string, plain: string): string {
  const plainBytes = Buffer.from(plain, 'utf8')
  const stream = keystream(keyHex, plainBytes.length)
  const out = Buffer.alloc(plainBytes.length)
  for (let i = 0; i < plainBytes.length; i += 1) out[i] = plainBytes[i]! ^ stream[i]!
  return out.toString('base64')
}

/** 解密：base64 密文 → 明文（异或对称，同 keystream）。 */
export function xorDecrypt(keyHex: string, cipherB64: string): string {
  const cipher = Buffer.from(cipherB64, 'base64')
  const stream = keystream(keyHex, cipher.length)
  const out = Buffer.alloc(cipher.length)
  for (let i = 0; i < cipher.length; i += 1) out[i] = cipher[i]! ^ stream[i]!
  return out.toString('utf8')
}
