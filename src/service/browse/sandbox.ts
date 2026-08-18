/**
 * 文件夹浏览沙箱（config.workspace.browse.*）。
 *
 * 安全边界 = 根目录锚定：浏览仅限 `server.workspace_browse.roots` 白名单内；
 * 路径穿越（词法锚定 + realpath 软链逃逸双重校验）、`.chery` 一律拒绝。
 * 目录无权限 → 结构化 `{ accessible:false }` 返回（不 throw，前端据此提示「下级无法加载」）。
 *
 * 纯逻辑（读配置仅经 effectiveBrowseRoots / validateBrowseRoots 两个入口），可单测。
 * 注意：本模块**绝不输出浏览路径**到日志（加密协议的意义所在，见 handler.ts）。
 */
import { accessSync, constants, existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import { homedir } from 'node:os'
import { posix as posixPath, win32 as winPath } from 'node:path'
import type { PathLike } from 'node:fs'
import config from '@/utils/config.js'
import { isCheryPath } from '@/utils/pathGuard.js'

/** 单条目（加密载荷内）。 */
export interface BrowseEntry {
  name: string
  path: string
  isDir: boolean
  /** 尽力探测的可读性（Windows R_OK 不可靠，点击时才由 readdir 权威判定） */
  accessible: boolean
}

/** list 加密载荷明文形态（前后端契约）。 */
export interface BrowseListPayload {
  path: string
  accessible: boolean
  error?: string
  entries: BrowseEntry[]
}

/** 根白名单条目（start 明文返回）。 */
export interface BrowseRoot {
  path: string
  name: string
}

/** list 沙箱入参（由 handler 从会话 + 配置组装）。 */
export interface BrowseOptions {
  roots: BrowseRoot[]
  includeFiles: boolean
  showHidden: boolean
  maxDepth?: number
}

// ---- 跨平台适配 -------------------------------------------------------------

/** 平台路径模块：win32 → path.win32，其余 → path.posix。 */
export function pathFor(platform: NodeJS.Platform): typeof posixPath {
  return platform === 'win32' ? winPath : posixPath
}

/** 显示分隔符：win32 → '\\'，其余 '/'。 */
export function sepFor(platform: NodeJS.Platform): '/' | '\\' {
  return platform === 'win32' ? '\\' : '/'
}

/** win32 缺省根：枚举存在盘符 A:\..Z:\（仅 win32 平台探测，其余返回空）。 */
export function enumerateWindowsDrives(): string[] {
  if (process.platform !== 'win32') return []
  const out: string[] = []
  for (let i = 0; i < 26; i += 1) {
    const d = `${String.fromCharCode(65 + i)}:\\`
    try {
      if (existsSync(d)) out.push(d)
    } catch {
      // 单个盘符探测失败跳过，不中断
    }
  }
  return out
}

/**
 * 缺省浏览根 = **全盘**（默认用户可访问任意路径，权限由系统对后端的实际访问报错把关）：
 * POSIX → `/`；win32 → 全部存在盘符（无盘符则回退 home）。
 * 配置了 `server.workspace_browse.roots` 白名单时收窄为其集合内（见 effectiveBrowseRoots）。
 */
export function defaultRoots(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const drives = enumerateWindowsDrives()
    return drives.length ? drives : [homedir()]
  }
  return ['/']
}

/**
 * 规范化单个根：~ 展开 → 绝对路径化 → 拒绝 .chery → 必须存在且为目录。
 * 任一不满足返回 null（调用方：effectiveBrowseRoots 过滤 / validateBrowseRoots 告警）。
 */
export function normalizeRoot(raw: string, platform: NodeJS.Platform): BrowseRoot | null {
  const p = pathFor(platform)
  let expanded = raw
  if (expanded === '~' || expanded.startsWith('~/') || expanded.startsWith('~\\')) {
    expanded = homedir() + expanded.slice(1)
  }
  const normalized = p.normalize(expanded)
  if (!p.isAbsolute(normalized)) return null
  if (isCheryPath(normalized)) return null
  try {
    if (!statSync(normalized).isDirectory()) return null
  } catch {
    return null
  }
  return { path: normalized, name: p.basename(normalized) || normalized }
}

/** 从运行时配置解析生效根白名单（无效项过滤；全无效 → 空数组）。 */
export function effectiveBrowseRoots(): BrowseRoot[] {
  const cfg = config.server.workspace_browse
  const platform = process.platform
  const raw = cfg?.roots?.length ? cfg.roots : defaultRoots(platform)
  return raw.map((r) => normalizeRoot(r, platform)).filter((r): r is BrowseRoot => r !== null)
}

/** 启动期校验 roots，返回告警列表（无效根逐条说明；规则 12 fail-loud）。 */
export function validateBrowseRoots(): string[] {
  const cfg = config.server.workspace_browse
  const platform = process.platform
  const raw = cfg?.roots?.length ? cfg.roots : defaultRoots(platform)
  const warnings: string[] = []
  for (const r of raw) {
    if (!normalizeRoot(r, platform)) warnings.push(`workspace_browse 根目录无效已忽略: ${r}`)
  }
  return warnings
}

// ---- 沙箱主入口 -------------------------------------------------------------

/** 尽力探测可读性（R_OK；Windows 不可靠，仅供列表行内禁用提示，非权威）。 */
function isReadable(target: PathLike): boolean {
  try {
    accessSync(target, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function notAccessible(path: string, error: string): BrowseListPayload {
  return { path, accessible: false, error, entries: [] }
}

/** 目录优先 + 自然序（numeric + 大小写不敏感）。 */
function sortEntries(a: BrowseEntry, b: BrowseEntry): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * 词法判定 target 是否落在 root 内。root 以分隔符结尾（Windows 盘符 `C:\`、POSIX `/`）时
 * **不再追加分隔符**，否则 `r.path + sep` 拼成双分隔符 `C:\\` 使 startsWith 永不命中。
 */
export function isWithinRoot(target: string, rootPath: string, sep: string): boolean {
  if (target === rootPath) return true
  const base = rootPath.endsWith(sep) ? rootPath : rootPath + sep
  return target.startsWith(base)
}

/** 单层目录列举（不递归，有界）。入口 path 为服务端已解密明文。 */
export function listBrowseEntries(rawPath: string, opts: BrowseOptions): BrowseListPayload {
  const p = pathFor(process.platform)
  const sep = sepFor(process.platform)

  // 1. 根选择层
  if (!rawPath) {
    if (!opts.roots.length) return notAccessible('', '未配置可浏览的根目录')
    if (opts.roots.length === 1) return listBrowseEntries(opts.roots[0]!.path, opts)
    return {
      path: '',
      accessible: true,
      entries: opts.roots.map((r) => ({
        name: r.name,
        path: r.path,
        isDir: true,
        accessible: isReadable(r.path),
      })),
    }
  }

  // 2. 必须绝对路径
  if (!p.isAbsolute(rawPath)) return notAccessible(rawPath, '路径必须是绝对路径')

  // 3. 词法根锚定
  const root = opts.roots.find((r) => isWithinRoot(rawPath, r.path, sep))
  if (!root) return notAccessible(rawPath, '超出可浏览范围')

  // 4. .chery 段
  if (isCheryPath(rawPath)) return notAccessible(rawPath, '系统配置目录不可浏览')

  // 5. realpath 软链逃逸校验（权威）
  let real: string
  try {
    real = realpathSync(rawPath)
  } catch {
    return notAccessible(rawPath, '目录不存在或不可访问')
  }
  if (!isWithinRoot(real, root.path, sep)) {
    return notAccessible(rawPath, '超出可浏览范围')
  }

  // 6. 最大深度（可选）
  if (opts.maxDepth !== undefined) {
    const depth =
      rawPath.split(sep).filter(Boolean).length - root.path.split(sep).filter(Boolean).length
    if (depth > opts.maxDepth) return notAccessible(rawPath, '超出浏览深度')
  }

  // 7. 必须是目录
  let st
  try {
    st = statSync(rawPath)
  } catch {
    return notAccessible(rawPath, '目录不存在或不可访问')
  }
  if (!st.isDirectory()) return notAccessible(rawPath, '不是目录')

  // 8. readdir（权限 → 结构化返回，不 throw）
  let names: Dirent[]
  try {
    names = readdirSync(rawPath, { withFileTypes: true })
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EACCES' || code === 'EPERM')
      return notAccessible(rawPath, '下级无法加载（无权限）')
    return notAccessible(rawPath, String((e as Error).message))
  }
  if (!names.length) return { path: rawPath, accessible: true, entries: [] }

  // 9. 过滤：.chery 恒隐藏 → 隐藏项（可选）→ 文件（可选；软链条目 isDirectory 为 false 天然排除）
  const entries: BrowseEntry[] = []
  for (const dirent of names) {
    const name = dirent.name
    if (name === '.chery') continue
    if (!opts.showHidden && name.startsWith('.')) continue
    const isDir = dirent.isDirectory()
    if (!isDir && !opts.includeFiles) continue
    const full = p.join(rawPath, name)
    entries.push({ name, path: full, isDir, accessible: isReadable(full) })
  }

  // 10. 排序：目录优先 + 自然序
  return { path: rawPath, accessible: true, entries: entries.sort(sortEntries) }
}
