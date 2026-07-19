import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface VcsInfo {
  type: 'git' | 'svn'
  /** git: 分支名 / detached HEAD 标识；svn: 缺失 */
  branch?: string
  /** git: ahead/behind 相对 upstream（无 upstream 时缺失） */
  ahead?: number
  behind?: number
  /** 工作区是否有未提交改动（含未跟踪 for git；svn 仅 tracked） */
  dirty: boolean
  /** git: HEAD -1 oneline；svn: 缺失 */
  lastCommit?: string
  /** git: remote "origin" URL；svn: info --show-item url */
  remote?: string
  /** svn: 工作副本 revision */
  revision?: string
}

function tryRun(cmd: string, cwd: string): string | null {
  try {
    const out = execSync(cmd, {
      cwd,
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    })
    return out.trim()
  } catch {
    return null
  }
}

function detectGit(cwd: string): VcsInfo | null {
  // rev-parse 成功即确认为 git 仓库
  if (tryRun('git rev-parse --is-inside-work-tree', cwd) !== 'true') return null

  // 分支：symbolic-ref 失败时退回 short HEAD（detached）
  let branch: string | undefined = tryRun('git symbolic-ref --short HEAD', cwd) ?? undefined
  if (!branch) {
    const head = tryRun('git rev-parse --short HEAD', cwd)
    branch = head ? `HEAD(${head})` : undefined
  }

  // ahead/behind：status -sb 解析 "## main...origin/main [ahead N, behind M]"
  let ahead: number | undefined
  let behind: number | undefined
  const statusHead = tryRun('git status -sb --porcelain', cwd)
  if (statusHead) {
    const firstLine = statusHead.split('\n', 1)[0] ?? ''
    const m = firstLine.match(/^##\s+\S+?(?:\.{3}\S+?)?(?:\s+\[([^\]]+)])?/)
    if (m?.[1]) {
      const am = m[1].match(/ahead\s+(\d+)/)
      const bm = m[1].match(/behind\s+(\d+)/)
      if (am) ahead = Number(am[1])
      if (bm) behind = Number(bm[1])
    }
  }

  // dirty：porcelain 有任何输出即为 dirty
  const porcelain = tryRun('git status --porcelain', cwd)
  const dirty = porcelain !== null && porcelain.length > 0

  const lastCommit = tryRun('git log -1 --pretty=oneline', cwd) || undefined
  const remote = tryRun('git remote get-url origin', cwd) || undefined

  return { type: 'git', branch, ahead, behind, dirty, lastCommit, remote }
}

function detectSvn(cwd: string): VcsInfo | null {
  // .svn 目录存在才尝试（svn info 在没有仓库时退出码非 0）
  if (!existsSync(`${cwd.replace(/[/\\]$/, '')}/.svn`)) return null
  const url = tryRun('svn info --show-item url', cwd)
  if (url === null) return null
  const revision = tryRun('svn info --show-item revision', cwd) || undefined
  const status = tryRun('svn status --quiet', cwd)
  const dirty = status !== null && status.length > 0
  // svn 没有"远程"概念，但 url 是仓库地址，复用 remote 字段
  return { type: 'svn', remote: url, revision, dirty }
}

/**
 * 探测 cwd 的 VCS 类型并采集默认元信息（分支/状态/远程等）。
 * 失败返回 null（调用方静默降级）。
 */
export function detectVcs(cwd: string): VcsInfo | null {
  return detectGit(cwd) ?? detectSvn(cwd)
}

/**
 * 将 VcsInfo 格式化为 <vcs> XML 片段，供拼入 system prompt。
 * info 为 null 时返回空串。
 */
export function formatVcsBlock(info: VcsInfo | null): string {
  if (!info) return ''
  const lines: string[] = []
  if (info.type === 'git') {
    if (info.branch) lines.push(`分支: ${info.branch}`)
    if (info.ahead !== undefined || info.behind !== undefined) {
      lines.push(`同步: ahead ${info.ahead ?? 0}, behind ${info.behind ?? 0}`)
    }
    lines.push(`状态: ${info.dirty ? '有未提交改动' : '干净'}`)
    if (info.lastCommit) lines.push(`最新提交: ${info.lastCommit}`)
    if (info.remote) lines.push(`远程: ${info.remote}`)
  } else {
    if (info.remote) lines.push(`URL: ${info.remote}`)
    if (info.revision) lines.push(`版本: r${info.revision}`)
    lines.push(`状态: ${info.dirty ? '有未提交改动' : '干净'}`)
  }
  return `<vcs type="${info.type}">\n${lines.join('\n')}\n</vcs>`
}
