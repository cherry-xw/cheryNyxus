import { describe, expect, it } from 'vitest'
import { randomHex, xorDecrypt, xorEncrypt } from '@/utils/obfuscate.js'

/**
 * 固定 nonce 的 golden vector 由 **web/src/utils/obfuscate.ts**（纯 JS SHA-256 + TextEncoder/btoa，
 * 与 Node createHash 实现相互独立）一次性脚本产出——跨实现逐字节一致即证明 Node 迁移未破坏算法。
 */
const NONCE = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'

describe('obfuscate（SHA-256 CTR，Node 实现）', () => {
  it('golden vector：与 web 独立实现输出逐字节一致（含 unicode 路径）', () => {
    expect(xorEncrypt(NONCE, '/home/user/projects/demo')).toBe('xdgIi3HMPE0dobql/dsNTXimSAQ5FDAF')
    expect(xorEncrypt(NONCE, '/home/user/项目 A/子目录')).toBe(
      'xdgIi3HMPE0dobo8Lg2As7XyegS43M2NWZSGmYA=',
    )
    expect(xorEncrypt(NONCE, '/tmp/测试/中文路径/with space.ts')).toBe(
      'xcQKljsF/LWQfAD6awzKzo1V05zylOPu7U0KUH3KvtGKgHKt9Dc=',
    )
  })

  it('根选择层：空串明文 → 空串密文（schema 不设 .min(1) 的语义依据）', () => {
    expect(xorEncrypt(NONCE, '')).toBe('')
    expect(xorDecrypt(NONCE, '')).toBe('')
  })

  it('往返：解密(加密(x)) === x（unicode / 空格 / 空串）', () => {
    for (const plain of ['/home/user/项目/中文', '/tmp/a b/c.txt', '', '/']) {
      expect(xorDecrypt(NONCE, xorEncrypt(NONCE, plain))).toBe(plain)
    }
  })

  it('randomHex：32 hex 字符 + 唯一性', () => {
    const a = randomHex(16)
    const b = randomHex(16)
    expect(a).toHaveLength(32)
    expect(a).toMatch(/^[0-9a-f]+$/)
    expect(a).not.toBe(b)
  })

  it('不同 nonce → 不同密文（keystream 不复用）', () => {
    const plain = '/home/user/projects/demo'
    expect(xorEncrypt(NONCE, plain)).not.toBe(xorEncrypt('deadbeefdeadbeefdeadbeefdeadbeef', plain))
  })
})
