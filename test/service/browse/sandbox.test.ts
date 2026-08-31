import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  listBrowseEntries,
  isWithinRoot,
  defaultRoots,
  normalizeRoot,
  type BrowseOptions,
  type BrowseRoot,
} from '@/service/browse/sandbox.js'

/** 沙箱：根锚定 / .chery / 软链逃逸 / 权限结构化 / 过滤 / 排序 / 根选择层。 */

let root: string
let outside: string
let base: string

function opts(partial: Partial<BrowseOptions> = {}): BrowseOptions {
  return {
    roots: [{ path: root, name: 'root' }],
    includeFiles: false,
    showHidden: false,
    ...partial,
  }
}

function rootsOf(...paths: string[]): BrowseRoot[] {
  return paths.map((p) => ({ path: p, name: p.split('/').pop() || p }))
}

const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'chery-browse-'))
  root = join(base, 'root')
  outside = join(base, 'outside')
  mkdirSync(join(root, 'dirA', 'subA'), { recursive: true })
  mkdirSync(join(root, 'dirB'), { recursive: true })
  mkdirSync(join(root, '.hiddenDir'))
  mkdirSync(join(root, '.chery'))
  mkdirSync(join(root, 'noperm'))
  mkdirSync(outside, { recursive: true })
  writeFileSync(join(root, 'file1.txt'), 'a')
  writeFileSync(join(root, 'notes.md'), 'b')
  writeFileSync(join(root, 'dirB', 'z2.txt'), 'z')
  writeFileSync(join(root, 'dirA', 'z1.txt'), 'z')
  try {
    symlinkSync(outside, join(root, 'linkOutside'))
  } catch {
    // 平台不支持软链则跳过相关用例
  }
  if (canChmod) chmodSync(join(root, 'noperm'), 0o000)
})

afterAll(() => {
  if (canChmod) chmodSync(join(root, 'noperm'), 0o755)
  rmSync(base, { recursive: true, force: true })
})

describe('listBrowseEntries 根锚定', () => {
  it('根外路径拒绝（词法）', () => {
    const r = listBrowseEntries(join(outside, 'target.txt'), opts())
    expect(r.accessible).toBe(false)
    expect(r.error).toContain('超出可浏览范围')
  })

  it('路径穿越 ../ 逃逸拒绝', () => {
    const r = listBrowseEntries(join(root, 'dirA', '..', '..', '..', 'etc'), opts())
    expect(r.accessible).toBe(false)
    expect(r.error).toContain('超出可浏览范围')
  })

  it('相对路径拒绝', () => {
    const r = listBrowseEntries('dirA', opts())
    expect(r.accessible).toBe(false)
    expect(r.error).toContain('必须是绝对路径')
  })

  it('软链逃逸拒绝（realpath 权威校验）', () => {
    const link = join(root, 'linkOutside')
    if (!existsSync(link)) return
    const r = listBrowseEntries(link, opts())
    expect(r.accessible).toBe(false)
    expect(r.error).toContain('超出可浏览范围')
  })

  it('.chery 恒不可浏览（含 showHidden=true）', () => {
    const r = listBrowseEntries(join(root, '.chery'), opts({ showHidden: true }))
    expect(r.accessible).toBe(false)
    expect(r.error).toContain('系统配置目录')
  })
})

describe('listBrowseEntries 过滤 / 排序', () => {
  it('includeFiles=false 仅目录；文件被过滤', () => {
    const r = listBrowseEntries(root, opts())

    expect(r.accessible).toBe(true)
    const names = r.entries.map((e) => e.name)
    expect(names).toContain('dirA')
    expect(names).toContain('dirB')
    expect(names).not.toContain('file1.txt')
    expect(names).not.toContain('notes.md')
  })

  it('includeFiles=true 文件可见（API 层参数生效）', () => {
    const r = listBrowseEntries(root, opts({ includeFiles: true }))
    expect(r.entries.map((e) => e.name)).toContain('file1.txt')
  })

  it('.chery 条目恒隐藏（即使 showHidden）', () => {
    const r = listBrowseEntries(root, opts({ showHidden: true }))
    const names = r.entries.map((e) => e.name)
    expect(names).not.toContain('.chery')
  })

  it('showHidden=false 隐藏点开头；true 显示', () => {
    expect(listBrowseEntries(root, opts()).entries.map((e) => e.name)).not.toContain('.hiddenDir')
    expect(
      listBrowseEntries(root, opts({ showHidden: true })).entries.map((e) => e.name),
    ).toContain('.hiddenDir')
  })

  it('目录优先 + 自然序', () => {
    const r = listBrowseEntries(root, opts({ includeFiles: true }))
    const idx = (n: string) => r.entries.findIndex((e) => e.name === n)
    expect(idx('dirA')).toBeLessThan(idx('file1.txt'))
    expect(idx('dirB')).toBeLessThan(idx('notes.md'))
    // dirA / dirB 自然序
    expect(idx('dirA')).toBeLessThan(idx('dirB'))
  })

  it('空目录 → accessible:true, entries:[]', () => {
    const r = listBrowseEntries(join(root, 'dirA', 'subA'), opts())
    expect(r.accessible).toBe(true)
    expect(r.entries).toEqual([])
  })
})

describe('listBrowseEntries 权限', () => {
  it('EACCES → 结构化「下级无法加载（无权限）」（不 throw）', () => {
    if (!canChmod) return
    const r = listBrowseEntries(join(root, 'noperm'), opts())
    expect(r.accessible).toBe(false)
    expect(r.error).toContain('下级无法加载')
  })

  it('非目录路径 → 「不是目录」', () => {
    const r = listBrowseEntries(join(root, 'file1.txt'), opts())
    expect(r.accessible).toBe(false)
    expect(r.error).toContain('不是目录')
  })

  it('不存在 → 「目录不存在或不可访问」', () => {
    const r = listBrowseEntries(join(root, 'no-such'), opts())
    expect(r.accessible).toBe(false)
  })
})

describe('listBrowseEntries 根选择层', () => {
  it('单根：空串直接列根的子目录（entries 为目录内容）', () => {
    const r = listBrowseEntries('', opts())
    expect(r.accessible).toBe(true)
    expect(r.entries.some((e) => e.name === 'dirA')).toBe(true)
  })

  it('多根：空串返回根选项', () => {
    const multi = rootsOf(root, outside)
    const r = listBrowseEntries('', { roots: multi, includeFiles: false, showHidden: false })
    expect(r.accessible).toBe(true)
    expect(r.entries).toHaveLength(2)
    expect(r.entries.every((e) => e.isDir)).toBe(true)
  })

  it('无根 → 「未配置可浏览的根目录」', () => {
    const r = listBrowseEntries('', { roots: [], includeFiles: false, showHidden: false })
    expect(r.accessible).toBe(false)
    expect(r.error).toContain('未配置可浏览的根目录')
  })
})

describe('isWithinRoot（词法锚定，双分隔符回归守卫）', () => {
  it('普通根：自身与其下命中，兄弟/前缀歧义不命中', () => {
    expect(isWithinRoot('/home/user', '/home/user', '/')).toBe(true)
    expect(isWithinRoot('/home/user/proj', '/home/user', '/')).toBe(true)
    expect(isWithinRoot('/home/userX', '/home/user', '/')).toBe(false) // 前缀歧义：userX ≠ user/
    expect(isWithinRoot('/home/other', '/home/user', '/')).toBe(false)
  })

  it('根以分隔符结尾（Windows 盘符 C:\\、POSIX /）：不再追加分隔符', () => {
    expect(isWithinRoot('C:\\', 'C:\\', '\\')).toBe(true)
    expect(isWithinRoot('C:\\Users', 'C:\\', '\\')).toBe(true) // 单反斜杠，非 C:\\
    expect(isWithinRoot('C:\\Users\\me', 'C:\\', '\\')).toBe(true)
    expect(isWithinRoot('D:\\', 'C:\\', '\\')).toBe(false)
    expect(isWithinRoot('/', '/', '/')).toBe(true)
    expect(isWithinRoot('/tmp', '/', '/')).toBe(true)
  })
})

describe('全盘缺省（默认用户可访问任意路径，权限靠系统报错）', () => {
  it('defaultRoots：POSIX 为 /，win32 为盘符（非 win32 不探测）', () => {
    expect(defaultRoots('linux')).toEqual(['/'])
    expect(defaultRoots('darwin')).toEqual(['/'])
    expect(Array.isArray(defaultRoots('win32'))).toBe(true)
  })

  it('normalizeRoot("/") 合法（全盘根）', () => {
    const r = normalizeRoot('/', 'linux')
    expect(r).not.toBeNull()
    expect(r!.path).toBe('/')
    expect(r!.name).toBe('/')
  })

  it.skipIf(process.platform === 'win32')(
    "'/' 根锚定任意路径：/tmp 下临时目录可列（全盘语义）",
    () => {
    const r = listBrowseEntries(root, {
      roots: [{ path: '/', name: '/' }],
      includeFiles: false,
      showHidden: false,
    })
    expect(r.accessible).toBe(true)
    expect(r.entries.some((e) => e.name === 'dirA')).toBe(true)
    },
  )
})
