/**
 * Skill / Plugin 导入共用工具（ZIP 解压 + GitHub 拉取 + 暂存 + 校验）。
 *
 * 设计：
 *   - 两阶段导入：stage（解压/fetch 到 .chery/.staging/<uuid>/）→ 前端逐项确认 → commit（移入 skills_dir / plugins_dir）。
 *   - 安全：路径穿越拒绝（.. / 绝对路径）、名称 sanitize（[a-zA-Z0-9_-]+）、zip bomb 硬阈值。
 *   - skill 文件名规范化：任意大小写 skill.md → SKILL.md（loadSkill 已大小写不敏感匹配，模板统一大写）。
 *
 * 被 skill/import.ts（独立 skill 导入）与 plugin/（插件整仓导入）复用。
 */
import {
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  rmSync,
  mkdirSync,
  statSync,
  type Dirent,
} from 'fs'
import { join, resolve, basename, posix } from 'path'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import AdmZip from 'adm-zip'
import yaml from 'js-yaml'
import config from '@/utils/config.js'
import { isSkillFile, SKILL_FILE_NAME } from '@/agent/prompt/loadSkill.js'

/** 合法名：仅 [a-zA-Z0-9_-]+（与 command handler 一致）。 */
export const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/

/** zip 解压硬上限：总解压字节 / 条目数（防 zip bomb）。 */
const MAX_EXTRACT_BYTES = 100 * 1024 * 1024 // 100MB
const MAX_ENTRY_COUNT = 5000

export function skillsDir(): string {
  return config.global.skills_dir
}
export function pluginsDir(): string {
  return config.global.plugins_dir
}
export function stagingRoot(): string {
  // /tmp 中转：外部不可信内容（zip / git clone）与 .chery/ 物理隔离，commit 时 cpSync 进 .chery/。
  // 所有导入路径（RPC skills/plugins + install_skill 感官）统一此 staging。commit 用 cpSync 跨 fs 安全。
  return join(tmpdir(), 'chery-staging')
}

/**
 * 名称 sanitize：非法字符替换为 `-`，折叠连续 `-`，去首尾 `-`。
 * @throws 空（sanitize 后无有效字符）→ fail-loud
 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!cleaned) throw new Error(`名称 "${raw}" sanitize 后为空（需含 [a-zA-Z0-9_-]）`)
  return cleaned
}

/** 校验 zip 条目相对路径安全（拒绝 .. / 绝对路径 / 盘符）。 */
function assertSafeEntryPath(entryPath: string): string {
  const norm = posix.normalize(entryPath).replace(/\\/g, '/')
  if (posix.isAbsolute(norm) || /^[a-zA-Z]:/.test(norm)) {
    throw new Error(`非法 zip 条目路径（绝对路径）: ${entryPath}`)
  }
  const parts = norm.split('/')
  if (parts.some((p) => p === '..')) {
    throw new Error(`非法 zip 条目路径（含 ..）: ${entryPath}`)
  }
  return norm
}

/** 创建暂存目录 .chery/.staging/<uuid>/，返回 { id, dir }。 */
export function createStaging(): { id: string; dir: string } {
  const id = randomUUID()
  const dir = join(stagingRoot(), id)
  mkdirSync(dir, { recursive: true })
  return { id, dir }
}

/** 删除暂存目录（commit 后或 abort 时清理）。 */
export function removeStaging(id: string): void {
  const dir = join(stagingRoot(), id)
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
}

/** 安全删除 .chery/ 下目录（skill 删除 / plugin 卸载）。最终路径必须在 .chery/ 内且非根。 */
export function removeCherySubdir(absDir: string): void {
  const cheryRoot = resolve(process.env.CHERY_DIR || process.cwd(), '.chery')
  const resolved = resolve(absDir)
  if (resolved === cheryRoot) throw new Error('拒绝删除 .chery 根目录')
  if (!resolved.startsWith(cheryRoot + '/')) {
    throw new Error(`拒绝删除 .chery/ 外的目录: ${absDir}`)
  }
  if (existsSync(resolved)) rmSync(resolved, { recursive: true, force: true })
}

/**
 * 解压 zip Buffer 到 destDir，带路径穿越防护 + zip bomb 限制。
 * 条目路径经 posix 规范化后拼接，跳过目录条目本身（按文件写）。
 */
export function extractZipBuffer(buf: Buffer, destDir: string): void {
  const zip = new AdmZip(buf)
  const entries = zip.getEntries()
  if (entries.length > MAX_ENTRY_COUNT) {
    throw new Error(`zip 条目数超限（${entries.length} > ${MAX_ENTRY_COUNT}）`)
  }
  mkdirSync(destDir, { recursive: true })
  let totalBytes = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const safeRel = assertSafeEntryPath(entry.entryName)
    const target = join(destDir, safeRel)
    // 二次校验：最终路径必须仍在 destDir 内
    if (
      !resolve(target).startsWith(resolve(destDir) + '/') &&
      resolve(target) !== resolve(destDir)
    ) {
      throw new Error(`zip 条目逃逸目标目录: ${entry.entryName}`)
    }
    const data = entry.getData()
    totalBytes += data.length
    if (totalBytes > MAX_EXTRACT_BYTES) {
      throw new Error(`zip 解压总字节超限（> ${MAX_EXTRACT_BYTES}）`)
    }
    // 直接写 Buffer 到已校验的安全路径（避免 extractEntryTo 的 maintainEntryPath 歧义）
    mkdirSync(resolve(target, '..'), { recursive: true })
    writeFileSync(target, data)
  }
}

export interface ParsedGithubUrl {
  owner: string
  /** 不含 .git 后缀的仓库名。 */
  repo: string
  /** URL 中显式指定的分支（/tree/<branch>）；未指定则 undefined → 走默认分支解析。 */
  branch?: string
  /** /tree/<branch>/<subpath> 捕获的子路径；当前 UNUSED（整仓安装），仅保留字段。 */
  subpath?: string
  /** 规范化的 https .git URL，供 `git clone` 使用。 */
  gitUrl: string
  /** 主机名（如 "github.com"），不硬编码 github.com，支持任意 git 托管。 */
  host: string
}

/**
 * 解析 git 仓库 URL：支持 https://host/<owner>/<repo>[.git][/tree/<branch>[/<subpath>]]
 * 与两种 SSH 形式（`git@host:owner/repo.git` / `ssh://git@host/owner/repo.git`）。
 * 不硬编码 github.com——任何 host 都接受，只要路径形状符合 /<owner>/<repo>。
 * 失败 fail-loud 抛错。subpath 当前仅捕获不做用（整仓安装）。
 */
export function parseGithubUrl(url: string): ParsedGithubUrl {
  const trimmed = url.trim()
  if (!trimmed) throw new Error('无法解析空 URL')

  let host: string
  let pathname: string

  // SSH 形式 1：git@github.com:owner/repo.git（SCP-like）
  const ssh1 = trimmed.match(/^([^@]+)@([^:\/]+):(.+)$/)
  if (ssh1) {
    host = ssh1[2]!
    pathname = '/' + ssh1[3]!
  } else {
    // SSH 形式 2：ssh://git@github.com/owner/repo.git
    const ssh2 = trimmed.match(/^ssh:\/\/([^@\/]+)@([^\/]+)\/(.+)$/)
    if (ssh2) {
      host = ssh2[2]!
      pathname = '/' + ssh2[3]!
    } else {
      // 通用 URL 解析（https/http）
      let u: URL
      try {
        u = new URL(trimmed)
      } catch {
        throw new Error(`无法解析 URL: ${trimmed}`)
      }
      if (u.protocol !== 'https:' && u.protocol !== 'http:') {
        throw new Error(`仅支持 https:// 或 git@ SSH URL（当前协议: ${u.protocol}）`)
      }
      host = u.host
      pathname = u.pathname
    }
  }

  // owner/repo[/tree/<branch>[/<subpath>]] —— repo 用 lazy `[^/]+?` 安全：尾部组均锚定到 $
  const m = pathname.match(/^\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(?:\/(.+))?)?\/?$/)
  if (!m) throw new Error(`URL 路径不符合 /<owner>/<repo> 规范: ${pathname}`)
  const owner = m[1]!
  const repo = m[2]!
  const branch = m[3]
  const subpath = m[4]
  if (!owner || !repo) {
    throw new Error(`URL 路径缺少 owner/repo: ${pathname}`)
  }
  if (!/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error(`仓库名包含非法字符（仅允许 [A-Za-z0-9._-]）: ${repo}`)
  }

  const gitUrl = `https://${host}/${owner}/${repo}.git`
  return { owner, repo, branch: branch || undefined, subpath: subpath || undefined, gitUrl, host }
}

export interface SkillFolderInfo {
  /** 含 skill.md 的目录绝对路径。 */
  folder: string
  /** 默认名（目录 basename，sanitize 前）。 */
  defaultName: string
}

/**
 * 在 root 下发现含 skill 文件的目录（最多下钻 maxDepth 层）。
 * 用于独立 skill 导入：zip/url 内每个含 skill.md 的文件夹 = 一个候选 skill。
 * 同一目录只计一次；不递归进入已命中的目录。
 */
export function findSkillFolders(root: string, maxDepth = 2): SkillFolderInfo[] {
  const found: SkillFolderInfo[] = []
  const seen = new Set<string>()
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const hasSkill = entries.some((e) => e.isFile() && isSkillFile(e.name))
    if (hasSkill) {
      found.push({ folder: dir, defaultName: basename(dir) })
      return // 不再下钻（该目录是一个 skill 单元）
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        const next = join(dir, e.name)
        if (!seen.has(next)) {
          seen.add(next)
          walk(next, depth + 1)
        }
      }
    }
  }
  walk(root, 0)
  return found
}

/** 轻量读取 skill 文件 frontmatter（name/description/trigger），不加载全文 token。失败返回空 meta。 */
export function peekSkillMeta(folder: string): {
  name?: string
  description?: string
  trigger?: string
} {
  try {
    const files = readdirSync(folder)
    const skillFile = files.find(isSkillFile)
    if (!skillFile) return {}
    const raw = readFileSync(join(folder, skillFile), 'utf-8')
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!m) return {}
    const fm = (yaml.load(m[1]!) || {}) as Record<string, unknown>
    return {
      name: typeof fm.name === 'string' && fm.name ? fm.name : undefined,
      description: typeof fm.description === 'string' ? fm.description : undefined,
      trigger: typeof fm.trigger === 'string' && fm.trigger ? fm.trigger : undefined,
    }
  } catch {
    return {}
  }
}

/**
 * 规范化目录内的 skill 文件名 → SKILL.md：删除其他大小写变体，保留一个 SKILL.md。
 * 若已是 SKILL.md 则不动；若仅 skill.md/Skill.md 则改名。
 */
export function normalizeSkillFileName(folder: string): void {
  const files = readdirSync(folder)
  const variants = files.filter((f) => isSkillFile(f))
  if (variants.length === 0) return
  const target = join(folder, SKILL_FILE_NAME)
  // 若已存在规范名，删除其他变体
  if (variants.includes(SKILL_FILE_NAME)) {
    for (const f of variants) {
      if (f !== SKILL_FILE_NAME) {
        try {
          rmSync(join(folder, f), { force: true })
        } catch {
          /* ignore */
        }
      }
    }
    return
  }
  // 否则取第一个变体改名
  renameSync(join(folder, variants[0]!), target)
}

/** 判断 skills_dir/<name> 是否已存在（冲突检测）。 */
export function skillDirExists(name: string): boolean {
  return existsSync(join(skillsDir(), name))
}

/** 判断 plugins_dir/<name> 是否已存在（冲突检测）。 */
export function pluginDirExists(name: string): boolean {
  return existsSync(join(pluginsDir(), name))
}

/** stat 兜底：目录是否存在且是目录。 */
export function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
