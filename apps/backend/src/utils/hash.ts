import { createHash } from 'crypto'

/**
 * 生成 SHA256 hash（柯里化函数）
 * @param parts 各段字符串，第一段为前缀，后续段用 ':' 连接
 * @returns SHA256 hash 值
 *
 * @example
 * hashGenerator('file', path, size, mtime) // -> "file::path:size:mtime"
 * hashGenerator('file', path, size, mtime, offset, limit) // -> "file::path:size:mtime:offset:limit"
 * hashGenerator('skill', name) // -> "skill::name"
 */
export function hashGenerator(...parts: string[]): string {
  const [prefix, ...rest] = parts
  return createHash('sha256')
    .update(`${prefix}::${rest.join(':')}`)
    .digest('hex')
}
