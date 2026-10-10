import path from 'node:path'
import { constants } from 'node:fs'
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import type { IngressSubject } from '@chery/plugin-api'

export type QQSubject = IngressSubject
const MAX_BYTES = 1024 * 1024
const locks = new Map<string, Promise<unknown>>()
export const qqSubjectSchema = z.object({
  selfId: z.string().regex(/^[1-9]\d{0,19}$/),
  userId: z.string().regex(/^[1-9]\d{0,19}$/),
  conversationType: z.enum(['private', 'group']),
  groupId: z.string().regex(/^[1-9]\d{0,19}$/).optional(),
}).strict().refine(s => s.conversationType !== 'group' || s.groupId !== undefined, '群身份缺少groupId')
export const qqReadFileSchema = z.object({
  path: z.string(), offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
}).strict()
export const qqWriteFileSchema = z.object({
  path: z.string(), content: z.string(),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export const textVersion = (text: string) => createHash('sha256').update(text).digest('hex')

/** Check every ancestor, including ancestors above the configured root. */
export async function safePath(target: string, createParents = false): Promise<void> {
  if (!path.isAbsolute(target) || target.includes('\0')) throw new Error('必须配置绝对目录')
  const absolute = path.resolve(target)
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep)
  let current = path.parse(absolute).root
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]!)
    const parent = i < parts.length - 1
    if (parent && createParents) {
      await mkdir(current, { mode: 0o700 }).catch((e: NodeJS.ErrnoException) => {
        if (e.code !== 'EEXIST') throw e
      })
    }
    try {
      const stat = await lstat(current)
      if (stat.isSymbolicLink() || (parent ? !stat.isDirectory() : !stat.isFile()))
        throw new Error('不支持符号链接或非普通文件')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || parent) throw e
    }
  }
}

export async function readSafeText(target: string): Promise<string> {
  await safePath(target)
  const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('仅支持不超过1MiB的文本文件')
    const bytes = await file.readFile()
    if (bytes.byteLength > MAX_BYTES) throw new Error('仅支持不超过1MiB的文本文件')
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('不支持二进制文件')
    return text
  } finally { await file.close() }
}

/** An abandoned lock is not reclaimed automatically: fail closed instead. */
export async function withFileLock<T>(target: string, action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const previous = locks.get(target) ?? Promise.resolve()
  const task = previous.catch(() => {}).then(async () => {
    signal?.throwIfAborted()
    await safePath(target, true)
    const lockPath = `${target}.lock`
    const deadline = Date.now() + 5000
    let lock: Awaited<ReturnType<typeof open>>
    while (true) {
      signal?.throwIfAborted()
      await safePath(lockPath)
      try {
        lock = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
        break
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
        if (Date.now() >= deadline) throw new Error('文件写入锁超时；请检查是否有中断的写入')
        await delay(20, undefined, { signal })
      }
    }
    try {
      signal?.throwIfAborted()
      return await action()
    } finally {
      await lock.close()
      await unlink(lockPath)
    }
  })
  locks.set(target, task)
  try { return await task } finally { if (locks.get(target) === task) locks.delete(target) }
}

export async function atomicText(target: string, text: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await safePath(target, true)
  const temporary = path.join(path.dirname(target), `.${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
    signal?.throwIfAborted()
    await safePath(target)
    await rename(temporary, target)
    const directory = await open(path.dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await directory.sync() } finally { await directory.close() }
  } finally {
    await unlink(temporary).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e })
  }
}

function fileTarget(root: string, subject: QQSubject, relative: string): string {
  qqSubjectSchema.parse(subject)
  if (!root || !path.isAbsolute(root) || root.includes('\0')) throw new Error('QQ个人文件持久目录未配置')
  if (!relative || relative.length > 512 || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0') || relative.split('/').some(p => !p || p === '..' || p === '.'))
    throw new Error('请提供个人目录内的相对文件路径')
  return path.join(root, subject.userId, ...relative.split('/'))
}

export async function readQQFile(root: string, subject: QQSubject, input: z.infer<typeof qqReadFileSchema>) {
  const parsed = qqReadFileSchema.parse(input)
  const text = await readSafeText(fileTarget(root, subject, parsed.path))
  const lines = text.split('\n'), offset = parsed.offset ?? 0
  return { path: parsed.path, version: textVersion(text), totalLines: lines.length, offset,
    content: lines.slice(offset, offset + (parsed.limit ?? 200)).join('\n').slice(0, 30000) }
}

export async function writeQQFile(root: string, subject: QQSubject, input: z.infer<typeof qqWriteFileSchema>, signal?: AbortSignal) {
  const parsed = qqWriteFileSchema.parse(input)
  if (Buffer.byteLength(parsed.content) > MAX_BYTES || parsed.content.includes('\0'))
    throw new Error('仅支持不超过1MiB的文本内容')
  const target = fileTarget(root, subject, parsed.path)
  return withFileLock(target, async () => {
    let existing: string | undefined
    try { existing = textVersion(await readSafeText(target)) } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    }
    if (existing !== parsed.expectedVersion) throw new Error('文件已存在或版本发生变化；请先读取，再提供expectedVersion更新')
    await atomicText(target, parsed.content, signal)
    return { path: parsed.path, version: textVersion(parsed.content), bytes: Buffer.byteLength(parsed.content) }
  }, signal)
}
