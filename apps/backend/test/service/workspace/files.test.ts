import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { normalizeWorkspacePath, resolveWorkspaceEntry } from '@/service/workspace/sandbox.js'
import { describeFileReferences, listFiles, readFile } from '@/service/workspace/handler.js'

let root = ''
vi.mock('@/db/chat.js', () => ({
  getChatWorkspace: (id: string) => (id === 'chat' ? root : undefined),
}))
vi.mock('@/utils/envGuard.js', () => ({
  redactEnvKeys: (text: string) => text.replaceAll('test-secret', '[REDACTED]'),
}))
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), 'nyxus-files-test-'))
  await fs.mkdir(path.join(root, '.chery'))
  await fs.mkdir(path.join(root, 'src'))
  await fs.writeFile(path.join(root, 'src', 'a b.ts'), 'const value = 1')
  await fs.writeFile(path.join(root, '.env'), 'TOKEN=test-secret')
  await fs.writeFile(path.join(root, 'large.png'), Buffer.alloc(2 * 1024 * 1024 + 1))
  await fs.writeFile(path.join(root, 'sample.bin'), Buffer.from([0, 1, 2, 31, 32, 65, 255]))
})
afterAll(async () => {
  if (root.startsWith(path.join(tmpdir(), 'nyxus-files-test-')))
    await fs.rm(root, { recursive: true, force: true })
})
describe('workspace files', () => {
  it.each([
    '../secret',
    'src/../../secret',
    '/etc/passwd',
    'C:secret',
    'C:/secret',
    '\\\\server\\share',
    '.chery/config.yaml',
    'src/.chery',
    'a:stream',
    'bad\0name',
  ])('rejects unsafe path %s', (input) => {
    expect(() => normalizeWorkspacePath(input)).toThrow()
  })
  it('lists hidden ordinary files but omits internal configuration', async () => {
    const result = await listFiles({} as never, { chatId: 'chat' })
    expect(result.entries.map((item) => item.name)).toContain('.env')
    expect(result.entries.map((item) => item.name)).not.toContain('.chery')
  })
  it('allows spaces and produces path-only references without reading content', async () => {
    const result = await describeFileReferences('chat', '使用 [[file:src/a b.ts]] 和 [[file:src/]]')
    expect(result).toContain('absolutePath')
    expect(result).toContain('directory')
    expect(result).not.toContain('const value = 1')
  })
  it('reports invalid references without returning unrelated files', async () => {
    const result = await describeFileReferences('chat', '[[file:../secret]]')
    expect(result).toContain('error')
    expect(result).not.toContain('"absolutePath":')
  })
  it('redacts text, bounds images, and rejects missing workspaces', async () => {
    expect((await readFile({} as never, { chatId: 'chat', path: '.env' })).content).toBe(
      'TOKEN=[REDACTED]',
    )
    expect(await readFile({} as never, { chatId: 'chat', path: 'large.png' })).toMatchObject({
      kind: 'binary',
      truncated: true,
    })
    expect(await readFile({} as never, { chatId: 'chat', path: 'sample.bin' })).toMatchObject({
      kind: 'binary',
      content: Buffer.from([0, 1, 2, 31, 32, 65, 255]).toString('base64'),
      size: 7,
    })
    await expect(listFiles({} as never, { chatId: 'missing' })).rejects.toThrow('没有关联工作区')
  })
  it('rejects a junction or symlink outside the workspace', async () => {
    const link = path.join(root, 'escape')
    await fs.symlink(tmpdir(), link, process.platform === 'win32' ? 'junction' : 'dir')
    await expect(resolveWorkspaceEntry(root, 'escape')).rejects.toThrow('超出')
    const entries = (await listFiles({} as never, { chatId: 'chat' })).entries
    expect(entries.some((item) => item.name === 'escape')).toBe(false)
    await fs.unlink(link)
  })
})
