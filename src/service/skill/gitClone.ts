/**
 * Git 传输共享层：异步 execFile 封装，供 plugin/skill 整仓克隆导入复用。
 *
 * 设计：
 *   - 异步（execFile + promisify），与 vcs.ts 的同步 execSync 区分（导入是长任务，不阻塞主循环）。
 *   - 认证：通过 GIT_CONFIG_PARAMETERS 注入 http.extraheader（Basic），避免写 credential helper 或落盘 .git-credentials。
 *   - GIT_TERMINAL_PROMPT=0 禁用交互提示——私仓未带 token 时直接失败而非挂起等待键盘。
 *   - 认证失败「软返回」（needsAuth=true）交由上层驱动 UI 重新收集凭据；其他错误 fail-loud。
 *
 * 安全：stderr 截断至 400 字符再抛（避免泄露带 token 的 URL 全文）；最终文案净化由调用方 handler 负责。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { rmSync } from 'node:fs'
import { parseGithubUrl } from './importShared.js'

const execFileP = promisify(execFile)

/** git 子进程统一选项：60s 超时 + 4MB 输出上限 + 隐藏控制台窗口（Windows）。 */
const EXEC_OPTS = {
  timeout: 60_000,
  windowsHide: true,
  encoding: 'utf8' as const,
  maxBuffer: 4 * 1024 * 1024,
}

/** 认证失败特征串（git/远端多种文案归一识别）。 */
const AUTH_FAIL =
  /Authentication failed|could not read Username|terminal prompts disabled|Permission denied|Invalid username or token|forbidden/i

/** 代理/网络失败特征串（命中则抛「代理连接失败：」前缀错误，便于前端分类）。 */
const PROXY_FAIL =
  /proxy|Connection timed out|Failed to connect to|Could not resolve host|ETIMEDOUT/i

/** 系统未安装 git CLI——与一般 git 错误区分，调用方可据此禁用 Git 导入入口。 */
export class GitNotInstalledError extends Error {
  readonly code = 'GIT_NOT_INSTALLED' as const
  constructor() {
    super('系统未安装 git CLI，Git 导入功能不可用')
    this.name = 'GitNotInstalledError'
  }
}

export interface GitAuth {
  username: string
  /** PAT 或实际口令（与 username 拼 Basic Auth 头）。 */
  password: string
}

export interface GitCloneResult {
  /** 克隆目标绝对路径（已去除 .git 目录）。 */
  dest: string
  /** HEAD commit SHA（best-effort，失败为空串）。 */
  commitSha: string
  /** HEAD 提交时间（ISO 8601，best-effort，失败为空串）。 */
  commitDate: string
}

/** 构造 git 子进程 env：基线禁用交互提示；提供 auth 时注入 Basic 头，提供 proxy 时注入 http/https.proxy。
 *  auth 与 proxy 可同时提供——两者以单引号参数并列于 GIT_CONFIG_PARAMETERS（同一字符串，空格分隔）。
 *  无 auth 无 proxy 时不写 GIT_CONFIG_PARAMETERS，与历史行为一致。
 */
function authEnv(auth?: GitAuth, proxy?: string): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0' }
  const params: string[] = []
  if (auth) {
    const b64 = Buffer.from(`${auth.username}:${auth.password}`).toString('base64')
    // 注意：GIT_CONFIG_PARAMETERS 的解析器要求每个参数用字面单引号包裹。
    //   'http.extraheader=Authorization: Basic <b64>'
    // 这里两侧的单引号是 git 自身语法的一部分，不是 JS 字符串引号——切勿误删，
    // 否则 git 解析 env 失败，认证头不会生效（私仓克隆会挂掉）。
    params.push(`'http.extraheader=Authorization: Basic ${b64}'`)
  }
  if (proxy) {
    // 同引号语法：'http.proxy=<url>' / 'https.proxy=<url>'——对 git 与 https 仓统一生效。
    params.push(`'http.proxy=${proxy}'`, `'https.proxy=${proxy}'`)
  }
  if (params.length > 0) {
    base.GIT_CONFIG_PARAMETERS = params.join(' ')
  }
  return base
}

interface GitRunOpts {
  cwd?: string
  env?: NodeJS.ProcessEnv
}

/** 执行 git 子进程；ENOENT（二进制缺失）统一升格为 GitNotInstalledError。 */
async function git(args: string[], opts?: GitRunOpts): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileP('git', args, {
      ...EXEC_OPTS,
      cwd: opts?.cwd,
      env: { ...process.env, ...opts?.env },
    })
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code?: unknown }).code === 'ENOENT'
    ) {
      throw new GitNotInstalledError()
    }
    throw err
  }
}

/** 截断 stderr 至 400 字符（防止把含 token 的完整 URL 回传给 UI）。 */
function truncateStderr(stderr: unknown): string {
  const s = (typeof stderr === 'string' ? stderr : '') ?? ''
  return s.length > 400 ? s.slice(0, 400) : s
}

/** 探测 git CLI 是否可用；不可用（ENOENT）抛 GitNotInstalledError。 */
export async function ensureGitAvailable(): Promise<void> {
  await git(['--version'])
}

/**
 * 列出远端分支 + 默认分支。
 * 认证失败软返回 needsAuth:true；ENOENT 抛 GitNotInstalledError；其他错误 fail-loud。
 * proxy 命中失败（超时/拒绝）抛「代理连接失败：」前缀错误，与一般 git 错误区分。
 */
export async function listRemoteBranches(
  url: string,
  auth?: GitAuth,
  proxy?: string,
): Promise<{ branches: string[]; defaultBranch: string | undefined; needsAuth: boolean }> {
  try {
    const { stdout } = await git(['ls-remote', '--heads', url], { env: authEnv(auth, proxy) })
    const branches: string[] = []
    for (const line of stdout.split('\n')) {
      const m = line.match(/^([0-9a-f]{40})\trefs\/heads\/(.+)$/)
      if (m) branches.push(m[2]!)
    }
    let defaultBranch: string | undefined
    try {
      const { stdout: sym } = await git(['ls-remote', '--symref', url, 'HEAD'], {
        env: authEnv(auth, proxy),
      })
      const m = sym.match(/ref:\s+refs\/heads\/(\S+)/)
      if (m) defaultBranch = m[1]
    } catch {
      // --symref 不支持或其他失败 → 默认分支留空，不影响分支列表本身
    }
    return { branches, defaultBranch, needsAuth: false }
  } catch (err) {
    if (err instanceof GitNotInstalledError) throw err
    const stderr =
      (err && typeof err === 'object' && 'stderr' in err
        ? (err as { stderr?: unknown }).stderr
        : '') ?? ''
    if (AUTH_FAIL.test(String(stderr))) {
      return { branches: [], defaultBranch: undefined, needsAuth: true }
    }
    if (PROXY_FAIL.test(String(stderr))) {
      throw new Error(
        `代理连接失败：无法通过代理连接仓库，请检查代理地址或网络（${truncateStderr(stderr)}）`,
      )
    }
    throw new Error(`git ls-remote 失败: ${truncateStderr(stderr)}`)
  }
}

/**
 * 浅克隆 (--depth 1 --no-tags) 到 dest；成功后剥除 .git 目录并采集 HEAD sha/date。
 * 认证失败抛带 `.needsAuth=true` 标记的 Error；ENOENT 抛 GitNotInstalledError；
 * proxy 命中失败抛「代理连接失败：」前缀错误；其他失败 fail-loud。
 */
export async function cloneRepo(
  url: string,
  dest: string,
  opts?: { branch?: string; auth?: GitAuth; proxy?: string },
): Promise<GitCloneResult> {
  const args = ['clone', '--depth', '1', '--no-tags']
  if (opts?.branch) {
    args.push('--branch', opts.branch)
  }
  args.push(url, dest)

  try {
    await git(args, { env: authEnv(opts?.auth, opts?.proxy) })
  } catch (err) {
    if (err instanceof GitNotInstalledError) throw err
    const stderr =
      (err && typeof err === 'object' && 'stderr' in err
        ? (err as { stderr?: unknown }).stderr
        : '') ?? ''
    if (AUTH_FAIL.test(String(stderr))) {
      const e = new Error('git clone 需要认证（凭据缺失或失效）') as Error & { needsAuth: boolean }
      e.needsAuth = true
      throw e
    }
    if (PROXY_FAIL.test(String(stderr))) {
      throw new Error(
        `代理连接失败：无法通过代理连接仓库，请检查代理地址或网络（${truncateStderr(stderr)}）`,
      )
    }
    throw new Error(`git clone 失败: ${truncateStderr(stderr)}`)
  }

  // 采集 HEAD commit 元数据（best-effort，失败留空）
  let commitSha = ''
  let commitDate = ''
  try {
    const { stdout } = await git(['log', '-1', '--format=%H|%cI'], { cwd: dest })
    const parts = stdout.trim().split('|')
    if (parts.length >= 1) commitSha = parts[0] ?? ''
    if (parts.length >= 2) commitDate = parts[1] ?? ''
  } catch {
    // 采集失败不阻塞导入流程
  }

  // 剥除 .git 目录（导入产物作为普通文件夹纳入 skills_dir/plugins_dir，不再具备 git 语义）
  try {
    rmSync(dest + '/.git', { recursive: true, force: true })
  } catch {
    // 删除失败非致命（磁盘空间问题留给后续清理）
  }

  return { dest, commitSha, commitDate }
}

/**
 * 查询远端分支最新版本（SHA + 可选提交时间）。
 * SHA 走 `git ls-remote <url> <branch>`；提交时间走 GitHub REST（best-effort，非 github.com 或限流时 undefined）。
 * 认证失败软返回 needsAuth:true；ENOENT 抛 GitNotInstalledError；
 * proxy 命中失败抛「代理连接失败：」前缀错误；其他 ls-remote 失败 fail-loud。
 */
export async function checkRemoteVersion(
  url: string,
  branch: string,
  auth?: GitAuth,
  proxy?: string,
): Promise<{ latestSha: string; latestDate?: string; needsAuth: boolean }> {
  let latestSha = ''
  try {
    const { stdout } = await git(['ls-remote', url, branch], { env: authEnv(auth, proxy) })
    const line = stdout.split('\n')[0] ?? ''
    const m = line.match(/^([0-9a-f]{40})\t/)
    if (m) latestSha = m[1]!
  } catch (err) {
    if (err instanceof GitNotInstalledError) throw err
    const stderr =
      (err && typeof err === 'object' && 'stderr' in err
        ? (err as { stderr?: unknown }).stderr
        : '') ?? ''
    if (AUTH_FAIL.test(String(stderr))) {
      return { latestSha: '', needsAuth: true }
    }
    if (PROXY_FAIL.test(String(stderr))) {
      throw new Error(
        `代理连接失败：无法通过代理连接仓库，请检查代理地址或网络（${truncateStderr(stderr)}）`,
      )
    }
    throw new Error(`git ls-remote 失败: ${truncateStderr(stderr)}`)
  }

  if (!latestSha) {
    // 分支在远端不存在（已被删除/改名）→ 视为无新版本
    return { latestSha: '', needsAuth: false }
  }

  // 提交时间走 GitHub REST（仅 github.com 语义可用；其他 host 或限流时静默降级为 undefined）
  let latestDate: string | undefined
  try {
    const parsed = parseGithubUrl(url)
    const apiUrl = `https://api.${parsed.host}/repos/${parsed.owner}/${parsed.repo}/commits/${latestSha}`
    const res = await fetch(apiUrl, {
      headers: {
        'User-Agent': 'CheryNyxus',
        Accept: 'application/vnd.github+json',
      },
    })
    if (res.ok) {
      const data = (await res.json()) as { commit?: { committer?: { date?: string } } }
      if (data.commit?.committer?.date) latestDate = data.commit.committer.date
    }
  } catch {
    // 网络失败/限流/非 GitHub → 留 undefined，不阻塞更新判断（基于 SHA 即可）
  }

  return { latestSha, latestDate, needsAuth: false }
}
