import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

/**
 * 密码加盐哈希（scrypt，零依赖）。
 * 存储格式：`scrypt$<saltHex>$<hashHex>`。
 * 加盐哈希：盐随机化，同密码不同罐；scrypt 内存硬，抗 GPU 爆破。
 */
const PREFIX = 'scrypt$'

/** 生成加盐 scrypt 哈希。测试可传固定 salt 保证确定性。 */
export function hashPassword(plain: string, salt: Buffer = randomBytes(16)): string {
  const hash = scryptSync(plain, salt, 32)
  return `${PREFIX}${salt.toString('hex')}$${hash.toString('hex')}`
}

/** 是否为已哈希存储格式（非明文）。 */
export function isHashed(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(PREFIX)
}

/** 校验明文密码是否匹配存储哈希。非哈希存储一律拒绝（fail loud）。 */
export function verifyPassword(plain: string, stored: string): boolean {
  if (!isHashed(stored)) return false
  const [, saltHex, hashHex, ...extra] = stored.split('$')
  if (!saltHex || !hashHex || extra.length) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(hashHex, 'hex')
  const actual = scryptSync(plain, salt, expected.length)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
