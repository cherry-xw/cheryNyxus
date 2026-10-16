import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, mkdir, chmod, rm } from 'node:fs/promises'
import {
  DEFAULT_RUNTIME_LIMITS,
  ManagedAppError,
  appIdSchema,
  qqRealUserIdSchema,
} from './types.ts'

const execFileAsync = promisify(execFile)

export interface ProjectQuotaUsage {
  projectId: number
  diskUsedBytes: number
  diskLimitBytes: number
  inodesUsed: number
  inodesLimit: number
}

/**
 * 逐级检查路径绝不包含符号链接（防软链逃逸）
 */
export async function assertNoSymlinkChain(
  baseRoot: string,
  targetPath: string,
): Promise<void> {
  const resolvedBase = path.resolve(baseRoot)
  const resolvedTarget = path.resolve(targetPath)
  if (
    resolvedTarget !== resolvedBase &&
    !resolvedTarget.startsWith(resolvedBase + path.sep)
  ) {
    throw new ManagedAppError(
      'APP_ACCESS_DENIED',
      '非法的项目目录路径（超出受管根范围）',
    )
  }

  const baseSt = await lstat(resolvedBase)
  if (baseSt.isSymbolicLink() || !baseSt.isDirectory()) {
    throw new ManagedAppError(
      'STORAGE_QUOTA_EXCEEDED',
      '受管根目录不能为符号链接',
    )
  }

  const rel = path.relative(resolvedBase, resolvedTarget)
  if (!rel) return

  let cur = resolvedBase
  for (const segment of rel.split(path.sep)) {
    cur = path.join(cur, segment)
    try {
      const st = await lstat(cur)
      if (st.isSymbolicLink()) {
        throw new ManagedAppError(
          'APP_ACCESS_DENIED',
          `检测到非法的符号链接路径段: ${segment}`,
        )
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        break
      }
      throw err
    }
  }
}

/**
 * XFS Project Quota 管理器
 * 负责在宿主机 XFS loopback 配额卷上为每个 {userId, appId} 强制设置：
 * - 容量硬限制 (默认 512 MiB)
 * - Inode 硬限制 (默认 20,000)
 */
export class XfsQuotaManager {
  private readonly xfsMountPoint: string
  private readonly hostUserFilesRoot: string
  private readonly diskQuotaBytes: number
  private readonly inodeQuota: number

  constructor(opts: {
    xfsMountPoint?: string
    hostUserFilesRoot?: string
    diskQuotaBytes?: number
    inodeQuota?: number
  } = {}) {
    this.xfsMountPoint = opts.xfsMountPoint ?? '/var/lib/cherynyxus-apps/mnt'
    this.hostUserFilesRoot =
      opts.hostUserFilesRoot ?? '/home/chery/docker/cherynyxus/user-files'
    this.diskQuotaBytes =
      opts.diskQuotaBytes ?? DEFAULT_RUNTIME_LIMITS.projectDiskQuotaBytes
    this.inodeQuota =
      opts.inodeQuota ?? DEFAULT_RUNTIME_LIMITS.projectInodeQuota
  }

  resolveAppPaths(userId: string, appId: string) {
    qqRealUserIdSchema.parse(userId)
    appIdSchema.parse(appId)

    const xfsAppRoot = path.join(this.xfsMountPoint, userId, 'apps', appId)
    const hostAppRoot = path.join(this.hostUserFilesRoot, userId, 'apps', appId)
    return {
      xfsAppRoot,
      hostAppRoot,
      projectDir: path.join(hostAppRoot, 'project'),
      dataDir: path.join(hostAppRoot, 'data'),
      backupsDir: path.join(hostAppRoot, 'backups'),
    }
  }

  /**
   * 校验底层挂载确实为启用了 prjquota 的 XFS 文件系统
   */
  async verifyQuotaFilesystemReady(): Promise<void> {
    const { stdout } = await execFileAsync('findmnt', [
      '-n',
      '-o',
      'FSTYPE,OPTIONS',
      this.xfsMountPoint,
    ]).catch(err => {
      throw new ManagedAppError(
        'STORAGE_QUOTA_EXCEEDED',
        `受管 XFS 配额卷未挂载 (${this.xfsMountPoint}): ${err.message}`,
      )
    })

    const text = stdout.trim()
    if (!text.includes('xfs') || !text.includes('prjquota')) {
      throw new ManagedAppError(
        'STORAGE_QUOTA_EXCEEDED',
        `受管存储卷未启用 XFS prjquota 硬配额 (${text})，拒绝启动应用容器`,
      )
    }
  }

  /**
   * 初始化应用目录并绑定内核 XFS project quota
   */
  async ensureProjectDirectoriesAndQuota(
    userId: string,
    appId: string,
    projectId: number,
  ): Promise<ReturnType<XfsQuotaManager['resolveAppPaths']>> {
    await this.verifyQuotaFilesystemReady()
    const paths = this.resolveAppPaths(userId, appId)

    await assertNoSymlinkChain(this.hostUserFilesRoot, paths.hostAppRoot)
    await assertNoSymlinkChain(this.xfsMountPoint, paths.xfsAppRoot)

    const userDir = path.join(this.hostUserFilesRoot, userId)
    const appsDir = path.join(userDir, 'apps')
    await mkdir(userDir, { recursive: true, mode: 0o711 })
    await chmod(userDir, 0o711)
    await mkdir(appsDir, { recursive: true, mode: 0o700 })
    await mkdir(paths.projectDir, { recursive: true, mode: 0o755 })
    await mkdir(paths.dataDir, { recursive: true, mode: 0o700 })
    await mkdir(paths.backupsDir, { recursive: true, mode: 0o700 })

    await assertNoSymlinkChain(this.hostUserFilesRoot, paths.projectDir)
    await assertNoSymlinkChain(this.hostUserFilesRoot, paths.dataDir)
    await assertNoSymlinkChain(this.hostUserFilesRoot, paths.backupsDir)
    await execFileAsync('chown', ['-R', '1000:1000', userDir, paths.xfsAppRoot])

    const limitMiB = Math.max(1, Math.floor(this.diskQuotaBytes / (1024 * 1024)))
    await execFileAsync('xfs_quota', [
      '-x',
      '-c',
      `project -s -p ${paths.xfsAppRoot} ${projectId}`,
      this.xfsMountPoint,
    ])
    await execFileAsync('xfs_quota', [
      '-x',
      '-c',
      `limit -p bsoft=${limitMiB}m bhard=${limitMiB}m isoft=${this.inodeQuota} ihard=${this.inodeQuota} ${projectId}`,
      this.xfsMountPoint,
    ])

    return paths
  }

  /**
   * 从内核 xfs_quota 读取指定 projectId 的实时字节与 inode 占用
   */
  async deleteProject(userId: string, appId: string, projectId: number): Promise<void> {
    if (!Number.isSafeInteger(projectId) || projectId < 10001) throw new ManagedAppError('INVALID_INPUT', '项目配额标识无效')
    await this.verifyQuotaFilesystemReady()
    const paths = this.resolveAppPaths(userId, appId)
    await assertNoSymlinkChain(this.hostUserFilesRoot, paths.hostAppRoot)
    await assertNoSymlinkChain(this.xfsMountPoint, paths.xfsAppRoot)
    // Remove the exact validated app root only; never recurse over user roots.
    await rm(paths.hostAppRoot, { recursive: true, force: true })
    if (paths.xfsAppRoot !== paths.hostAppRoot) await rm(paths.xfsAppRoot, { recursive: true, force: true })
    await execFileAsync('xfs_quota', ['-x', '-c', `limit -p bsoft=0 bhard=0 isoft=0 ihard=0 ${projectId}`, this.xfsMountPoint])
  }

  async inspectProjectQuota(projectId: number): Promise<ProjectQuotaUsage> {
    const { stdout } = await execFileAsync('xfs_quota', [
      '-x',
      '-c',
      'report -p -b -i -N',
      this.xfsMountPoint,
    ]).catch(() => ({ stdout: '' }))

    const prefix = `#${projectId}`
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim()
      if (!line.startsWith(prefix)) continue
      const cols = line.split(/\s+/)
      // 格式: #<projId> <b_used_kb> <b_soft_kb> <b_hard_kb> <b_warn> <b_grace> <i_used> <i_soft> <i_hard> ...
      if (cols.length >= 9 && cols[0] === prefix) {
        const usedKb = Number(cols[1]) || 0
        const hardKb = Number(cols[3]) || Math.floor(this.diskQuotaBytes / 1024)
        const inodesUsed = Number(cols[6]) || 0
        const inodesHard = Number(cols[8]) || this.inodeQuota
        return {
          projectId,
          diskUsedBytes: usedKb * 1024,
          diskLimitBytes: hardKb * 1024,
          inodesUsed,
          inodesLimit: inodesHard,
        }
      }
    }

    return {
      projectId,
      diskUsedBytes: 0,
      diskLimitBytes: this.diskQuotaBytes,
      inodesUsed: 0,
      inodesLimit: this.inodeQuota,
    }
  }
}
