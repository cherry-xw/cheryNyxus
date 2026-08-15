/**
 * 轻量对称加解密（SHA-256 CTR 流密码，纯 JS，无 WebCrypto 依赖）。
 *
 * 为何不用 WebCrypto：`crypto.subtle` 仅在安全上下文（HTTPS / localhost）可用；
 * 本应用可能经非 HTTPS 的远端地址连接（非安全上下文），`crypto.subtle` 为 undefined，
 * 调用 `.digest` 会抛 TypeError。此实现纯 JS，任何上下文可用。
 *
 * 安全边界：key 参与方可见（传输 = 后端下发的 nonce；本地 = localStorage 存储的 key），
 * 属**混淆级**——防明文落网/落盘 + 防重放（一次性 nonce），不防运行时提取。真实安全靠 HTTPS。
 *
 * 算法：`keystream = SHA-256(keyHex_U8 || BE32(counter))` 逐块拼接，与明文逐字节异或。
 * 与后端 Node 实现（src/service/auth/index.ts 的 xorDecrypt）严格一致。
 */

// ---- base64 / hex ---------------------------------------------------------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

export function bytesFromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 生成 byteLen 字节随机数（hex 字符串）。`crypto.getRandomValues` 所有上下文可用。 */
export function randomHex(byteLen: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen))
  let hex = ''
  for (const b of bytes) hex += b.toString(16).padStart(2, '0')
  return hex
}

// ---- 纯 JS SHA-256 --------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n))
}

/** SHA-256 摘要（32 字节）。输入任意字节数组。 */
export function sha256(bytes: Uint8Array): Uint8Array {
  let h0 = 0x6a09e667
  let h1 = 0xbb67ae85
  let h2 = 0x3c6ef372
  let h3 = 0xa54ff53a
  let h4 = 0x510e527f
  let h5 = 0x9b05688c
  let h6 = 0x1f83d9ab
  let h7 = 0x5be0cd19

  const origLen = bytes.length
  const bitLenHi = Math.floor((origLen * 8) / 0x100000000)
  const bitLenLo = (origLen * 8) >>> 0
  const paddedLen = ((origLen + 1 + 8 + 63) >> 6) << 6
  const msg = new Uint8Array(paddedLen)
  msg.set(bytes, 0)
  msg[origLen] = 0x80
  const dv = new DataView(msg.buffer)
  dv.setUint32(paddedLen - 8, bitLenHi)
  dv.setUint32(paddedLen - 4, bitLenLo)

  const w = new Uint32Array(64)
  for (let block = 0; block < paddedLen; block += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = dv.getUint32(block + i * 4)
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4
    let f = h5
    let g = h6
    let h = h7
    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i]! + w[i]!) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
    h5 = (h5 + f) >>> 0
    h6 = (h6 + g) >>> 0
    h7 = (h7 + h) >>> 0
  }

  const out = new Uint8Array(32)
  const odv = new DataView(out.buffer)
  odv.setUint32(0, h0)
  odv.setUint32(4, h1)
  odv.setUint32(8, h2)
  odv.setUint32(12, h3)
  odv.setUint32(16, h4)
  odv.setUint32(20, h5)
  odv.setUint32(24, h6)
  odv.setUint32(28, h7)
  return out
}

// ---- SHA-256 CTR 流密码 -----------------------------------------------------

/** 生成 length 字节异或密钥流：SHA-256(keyHex_U8 || BE32(counter)) 逐块拼接。 */
function keystream(keyHex: string, length: number): Uint8Array {
  const key = new TextEncoder().encode(keyHex)
  const out = new Uint8Array(length)
  const counter = new Uint8Array(4)
  const cdv = new DataView(counter.buffer)
  let counterVal = 0
  let offset = 0
  while (offset < length) {
    cdv.setUint32(0, counterVal)
    counterVal += 1
    const input = new Uint8Array(key.length + 4)
    input.set(key, 0)
    input.set(counter, key.length)
    const block = sha256(input)
    const take = Math.min(32, length - offset)
    out.set(block.subarray(0, take), offset)
    offset += take
  }
  return out
}

/** 加密：明文 → base64 密文。keyHex 为任意 hex 串（传输=后端 nonce；本地=随机 key）。 */
export function xorEncrypt(keyHex: string, plain: string): string {
  const plainBytes = new TextEncoder().encode(plain)
  const stream = keystream(keyHex, plainBytes.length)
  const out = new Uint8Array(plainBytes.length)
  for (let i = 0; i < plainBytes.length; i += 1) out[i] = plainBytes[i]! ^ stream[i]!
  return bytesToBase64(out)
}

/** 解密：base64 密文 → 明文（异或对称，同 keystream）。 */
export function xorDecrypt(keyHex: string, cipherB64: string): string {
  const cipher = bytesFromBase64(cipherB64)
  const stream = keystream(keyHex, cipher.length)
  const out = new Uint8Array(cipher.length)
  for (let i = 0; i < cipher.length; i += 1) out[i] = cipher[i]! ^ stream[i]!
  return new TextDecoder().decode(out)
}