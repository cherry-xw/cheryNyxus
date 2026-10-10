/**
 * Skill git 来源中央索引（.chery/.skill-sources.json）+ 来源管理 RPC handlers。
 *
 * 设计（用户确认）：
 *   - 按 {cloneUrl, branch} 分组的中央索引（非 per-skill manifest）-- skill 文件夹不携源。
 *   - sourceId = sha1(cloneUrl+branch) 前 12 位（稳定，re-import 同源自动合并）。
 *   - re-sync：重 clone + 重弹候选（analyzeSkillStaging 带 sourceId -> commit 时 upsert 更新该条目）。
 *   - 仅手动 re-sync，无 checkUpdate/版本徽标。
 *
 * 与 plugin 的 per-folder manifest 区别：技能多候选（一仓多 skill），用中央索引按来源分组更自然；
 * 删 skill 文件夹不自动清索引条目（listSources 时按实际存在过滤 skills 列表；commit/delete 时同步）。
 *
 * 循环依赖说明：本模块 import analyzeSkillStaging 自 import.ts，import.ts 反向 import upsertSource/
 * removeSkillFromSource/SkillManifestSource 自本模块。ESM live binding，双方仅在函数体内互调（非顶层求值），安全。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, readdirSync } from 'fs'
import { join, resolve } from 'path'
import { createHash } from 'crypto'
import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type SkillsListSourcesResponseData,
  type SkillSourceDTO,
  type SkillSourceEntry,
  type SkillsCheckSourceRequestData,
  type SkillsCheckSourceResponseData,
  type SkillsCheckAllSourcesRequestData,
  type SkillsCheckAllSourcesResponseData,
  type SkillsResyncSourceRequestData,
  type SkillsResyncSourceResponseData,
  type SkillsDeleteSourceRequestData,
  type SkillsDeleteSourceResponseData,
  type SkillsResyncAllSourcesRequestData,
  type SkillsResyncAllSourcesResponseData,
} from '../message/types.js'
import {
  skillsDir,
  createStaging,
  removeStaging,
  removeCherySubdir,
  normalizeSkillFileName,
} from './importShared.js'
import { cloneRepo, checkRemoteVersion, GitNotInstalledError } from './gitClone.js'
import { isGitAvailable, resolveAuth } from './credentials.js'
import { analyzeSkillStaging } from './import.js'

/** chery 根目录（CHERY_DIR/.chery，与 importShared.removeCherySubdir 同源）。 */
function cheryDir(): string {
  return resolve(process.env.CHERY_DIR || process.cwd(), '.chery')
}
/** 来源中央索引文件路径。 */
export function skillSourcesFile(): string {
  return join(cheryDir(), '.skill-sources.json')
}

/**
 * staging manifest 内嵌的 git 来源 meta（URL 导入/resync 才有；zip 无）。
 * 全字段可选以兼容 install_skill 仅传 sourceUrl 的旧调用。commit 时若 cloneUrl+branch 齐全则 upsert 索引。
 */
export interface SkillManifestSource {
  /** install_skill 旧字段（仅追溯，不进中央索引）。 */
  sourceUrl?: string
  cloneUrl?: string
  branch?: string
  /** 凭据池 id（re-sync 复用）；公开仓为 undefined。 */
  credentialId?: string
  commitSha?: string
  commitDate?: string
  /** resync 时带上（指向要更新的既有条目）；首次导入无。 */
  sourceId?: string
}

interface SkillSourcesFile {
  sources: SkillSourceEntry[]
}

/** sourceId = sha1(cloneUrl+branch) 前 12 位（稳定，同 url+branch 必同 id）。 */
export function makeSourceId(cloneUrl: string, branch: string): string {
  return createHash('sha1').update(`${cloneUrl}\n${branch}`).digest('hex').slice(0, 12)
}

/** 读索引（文件缺失/损坏返空数组，不抛错）。 */
function readSources(): SkillSourceEntry[] {
  const p = skillSourcesFile()
  if (!existsSync(p)) return []
  try {
    const data = JSON.parse(readFileSync(p, 'utf-8')) as SkillSourcesFile
    return Array.isArray(data.sources) ? data.sources : []
  } catch {
    return []
  }
}
/** 写索引（目录不存在则建）。 */
function writeSources(sources: SkillSourceEntry[]): void {
  mkdirSync(cheryDir(), { recursive: true })
  writeFileSync(skillSourcesFile(), JSON.stringify({ sources }, null, 2), 'utf-8')
}
/** 按 id 取条目。 */
export function getSource(sourceId: string): SkillSourceEntry | undefined {
  return readSources().find((s) => s.id === sourceId)
}

/**
 * upsert 来源条目（commit 时调）。
 * - source.sourceId 有 -> 更新该条目（resync：commitSha/Date/lastSyncedAt/skills 刷新）。
 * - 无 -> 按 makeSourceId(cloneUrl,branch) 查既有；存在则更新，不存在则新建。
 * 缺 cloneUrl/branch -> fail-loud（zip 导入不应调此函数）。
 * 成功路径清空 `lastSyncError`，防止旧错误遗留在新条目的可视化上。
 */
export function upsertSource(source: SkillManifestSource, skillNames: string[]): SkillSourceEntry {
  if (!source.cloneUrl || !source.branch) {
    throw new Error('upsertSource 缺 cloneUrl/branch（zip 导入不应写来源索引）')
  }
  const id = source.sourceId ?? makeSourceId(source.cloneUrl, source.branch)
  const now = new Date().toISOString()
  const sources = readSources()
  const idx = sources.findIndex((s) => s.id === id)
  const entry: SkillSourceEntry = {
    id,
    cloneUrl: source.cloneUrl,
    branch: source.branch,
    credentialId: source.credentialId,
    commitSha: source.commitSha ?? '',
    commitDate: source.commitDate ?? '',
    lastSyncedAt: now,
    skills: skillNames,
  }
  if (idx >= 0) sources[idx] = entry
  else sources.push(entry)
  writeSources(sources)
  return entry
}

/**
 * 从所有来源移除一个 skill 名（skills.delete 时调：删独立 skill 同步清索引）。
 * 不删除来源条目本身（即便 skills 空，保留供 resync/deleteSource）。
 */
export function removeSkillFromSource(name: string): void {
  const sources = readSources()
  let changed = false
  for (const s of sources) {
    if (s.skills.includes(name)) {
      s.skills = s.skills.filter((n) => n !== name)
      changed = true
    }
  }
  if (changed) writeSources(sources)
}

/** 删除来源条目（deleteSource 调；skill 文件夹由 handler 负责删）。 */
export function removeSource(sourceId: string): void {
  const sources = readSources().filter((s) => s.id !== sourceId)
  writeSources(sources)
}

/** skills.listSources：只返回仓库摘要，避免为来源卡读取数百个 skill frontmatter。 */
export async function handleSkillsListSources(
  _ctx: HandlerContext,
  _params: unknown,
): Promise<SkillsListSourcesResponseData> {
  const sources = readSources()
  const dtos: SkillSourceDTO[] = sources.map(({ skills, ...source }) => ({
    ...source,
    skillCount: skills.filter((name) => existsSync(join(skillsDir(), name))).length,
  }))
  return { sources: dtos }
}

function updateSourceCheck(sourceId: string, patch: Partial<SkillSourceEntry>): void {
  const sources = readSources()
  const idx = sources.findIndex((source) => source.id === sourceId)
  if (idx < 0) return
  sources[idx] = { ...sources[idx]!, ...patch }
  writeSources(sources)
}

export async function handleSkillsCheckSource(
  _ctx: HandlerContext,
  { sourceId }: SkillsCheckSourceRequestData,
): Promise<SkillsCheckSourceResponseData> {
  const entry = getSource(sourceId)
  if (!entry) throw new Error(`来源 ${sourceId} 不存在`)
  const auth = entry.credentialId ? resolveAuth(entry.credentialId) : undefined
  try {
    const remote = await checkRemoteVersion(entry.cloneUrl, entry.branch, auth)
    if (remote.needsAuth) throw new Error('关联凭据已失效或无权限')
    const updateAvailable = !!remote.latestSha && remote.latestSha !== entry.commitSha
    updateSourceCheck(sourceId, {
      lastCheckedAt: new Date().toISOString(),
      latestSha: remote.latestSha,
      latestDate: remote.latestDate,
      updateAvailable,
      lastCheckError: undefined,
    })
    return { sourceId, latestSha: remote.latestSha, latestDate: remote.latestDate, updateAvailable }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    updateSourceCheck(sourceId, {
      lastCheckedAt: new Date().toISOString(),
      lastCheckError: message,
    })
    throw error
  }
}

export async function handleSkillsCheckAllSources(
  ctx: HandlerContext,
  _data: SkillsCheckAllSourcesRequestData,
): Promise<SkillsCheckAllSourcesResponseData> {
  const sources = readSources()
  const failed: Array<{ sourceId: string; reason: string }> = []
  let updatesAvailable = 0
  for (const source of sources) {
    try {
      const result = await handleSkillsCheckSource(ctx, { sourceId: source.id })
      if (result.updateAvailable) updatesAvailable++
    } catch (error) {
      failed.push({
        sourceId: source.id,
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return { checked: sources.length, updatesAvailable, failed }
}

/** skills.resyncSource：重 clone 某来源 + 重分析候选（前端重弹候选预勾选）。 */
export async function handleSkillsResyncSource(
  _ctx: HandlerContext,
  { sourceId }: SkillsResyncSourceRequestData,
): Promise<SkillsResyncSourceResponseData> {
  const entry = getSource(sourceId)
  if (!entry) throw new Error(`来源 ${sourceId} 不存在（可能已被删除），请重新导入`)
  // credentialId 存在但凭据已删 -> resolveAuth 抛友好错；无 credentialId -> 匿名（公开仓）
  const auth = entry.credentialId ? resolveAuth(entry.credentialId) : undefined
  const { id, dir } = createStaging()
  const raw = join(dir, '_raw')
  let clone: { dest: string; commitSha: string; commitDate: string }
  try {
    clone = await cloneRepo(entry.cloneUrl, raw, { branch: entry.branch, auth })
  } catch (err) {
    removeStaging(id)
    if (err instanceof GitNotInstalledError) throw err
    if ((err as { needsAuth?: boolean }).needsAuth) {
      throw new Error('Git 鉴权失败：关联凭据已失效或无权限，请删除该来源后重新导入并输入新凭据')
    }
    throw err
  }
  const result = analyzeSkillStaging(id, raw, {
    cloneUrl: entry.cloneUrl,
    branch: entry.branch,
    credentialId: entry.credentialId,
    commitSha: clone.commitSha,
    commitDate: clone.commitDate,
    sourceId,
  })
  return {
    stagingId: result.stagingId,
    candidates: result.candidates,
    branch: entry.branch,
    commitSha: clone.commitSha,
    commitDate: clone.commitDate,
    sourceId,
    selected: entry.skills,
  }
}

/** skills.deleteSource：删来源条目 + 其跟踪的 skill 文件夹（镜像 plugins.uninstall）。 */
export async function handleSkillsDeleteSource(
  _ctx: HandlerContext,
  { sourceId }: SkillsDeleteSourceRequestData,
): Promise<SkillsDeleteSourceResponseData> {
  const entry = getSource(sourceId)
  if (!entry) throw new Error(`来源 ${sourceId} 不存在`)
  for (const name of entry.skills) {
    const dir = join(skillsDir(), name)
    if (existsSync(dir)) removeCherySubdir(dir)
  }
  removeSource(sourceId)
  return { ok: true }
}

/** skills.resyncAllSources：批量重拉全部来源（serial 串行，非交互）。
 *
 * 策略：每条来源 clone + analyze staging → 自动 commit 仅匹配原 entry.skills 命名的 candidate
 * （新增/删除 candidate 静默丢弃；批量刷新 ≠ 手动审核，避免破坏现有技能集合）。
 * 成功：upsertSource 写入新 commitSha/Date/lastSyncedAt/skills + 清空 lastSyncError。
 * 失败：捕获错误 → 写 lastSyncError 到该条目 → push { ok:false, error } → 继续下一条。
 * GitNotInstalledError 视为全局性：立即中止全部（return failures=count），不在各条记 lastSyncError
 * （用户已知道是 git 缺失，逐条标红无意义）。
 */
export async function handleSkillsResyncAllSources(
  _ctx: HandlerContext,
  _data: SkillsResyncAllSourcesRequestData,
): Promise<SkillsResyncAllSourcesResponseData> {
  const sources = readSources()
  if (sources.length === 0) {
    return { results: [], successes: 0, failures: 0 }
  }
  // 全局 git 探测：缺失时不浪费逐条 clone，直接全部失败。
  if (!(await isGitAvailable())) {
    return {
      results: sources.map((s) => ({ sourceId: s.id, ok: false, error: '系统 git 未安装' })),
      successes: 0,
      failures: sources.length,
    }
  }

  const results: SkillsResyncAllSourcesResponseData['results'] = []
  let successes = 0
  let failures = 0
  // serial 串行：保护磁盘与 git CLI 并发，且简化失败处理（一条不阻塞下一条）。
  for (const entry of sources) {
    try {
      const auth = entry.credentialId ? resolveAuth(entry.credentialId) : undefined
      const { id: stagingId, dir } = createStaging()
      const raw = join(dir, '_raw')
      const clone = await cloneRepo(entry.cloneUrl, raw, { branch: entry.branch, auth })
      const staged = analyzeSkillStaging(stagingId, raw, {
        cloneUrl: entry.cloneUrl,
        branch: entry.branch,
        credentialId: entry.credentialId,
        commitSha: clone.commitSha,
        commitDate: clone.commitDate,
        sourceId: entry.id,
      })
      // 自动 commit 决策：name ∈ 原 entry.skills → 覆盖式落盘；其他 → 跳过。
      const wantedSkills = new Set(entry.skills)
      const imported: string[] = []
      // 一次性拿到 raw 下子目录列表（sanitize 重命名后可能要按 basename 兜底匹配）。
      const rawDirs = readdirSync(raw, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
      for (const cand of staged.candidates) {
        if (!wantedSkills.has(cand.name)) continue
        const exact = rawDirs.includes(cand.name) ? cand.name : null
        const srcFolder = exact ? join(raw, exact) : null
        if (!srcFolder) continue
        const dest = join(skillsDir(), cand.name)
        cpSync(srcFolder, dest, { recursive: true, force: true })
        normalizeSkillFileName(dest)
        imported.push(cand.name)
      }
      // upsertSource 写 commitSha/Date/lastSyncedAt/skills 并清 lastSyncError
      upsertSource(
        {
          cloneUrl: entry.cloneUrl,
          branch: entry.branch,
          credentialId: entry.credentialId,
          commitSha: clone.commitSha,
          commitDate: clone.commitDate,
          sourceId: entry.id,
        },
        imported.length > 0 ? imported : entry.skills,
      )
      removeStaging(stagingId)
      results.push({
        sourceId: entry.id,
        ok: true,
        commitSha: clone.commitSha,
        commitDate: clone.commitDate,
      })
      successes++
    } catch (err) {
      const msg = (err as { message?: string })?.message ?? String(err)
      // 写失败 marker 到该条目（全局 git 缺失由前面拦截，剩下都是单条级别失败）
      writeSourceLastError(entry.id, msg)
      results.push({ sourceId: entry.id, ok: false, error: msg })
      failures++
    }
  }
  return { results, successes, failures }
}

/** 单独给某 source 写 lastSyncError，不动其它字段。 */
function writeSourceLastError(sourceId: string, error: string): void {
  const sources = readSources()
  const idx = sources.findIndex((s) => s.id === sourceId)
  if (idx < 0) return
  const cur = sources[idx]!
  sources[idx] = { ...cur, lastSyncError: error }
  writeSources(sources)
}

/** 注册 Skill 来源管理 RPC handlers。 */
export function registerSkillSourceHandlers(
  router: import('../message/router.js').RpcRouter,
): void {
  router.register(Method.SKILLS_LIST_SOURCES, handleSkillsListSources)
  router.register(Method.SKILLS_CHECK_SOURCE, handleSkillsCheckSource)
  router.register(Method.SKILLS_CHECK_ALL_SOURCES, handleSkillsCheckAllSources)
  router.register(Method.SKILLS_RESYNC_SOURCE, handleSkillsResyncSource)
  router.register(Method.SKILLS_RESYNC_ALL_SOURCES, handleSkillsResyncAllSources)
  router.register(Method.SKILLS_DELETE_SOURCE, handleSkillsDeleteSource)
}
