/**
 * Skill 导入后端（settings 「技能」tab）。
 *
 * 两阶段导入（支持前端逐项确认）：
 *   1. stage：ZIP 上传（HTTP /api/skills/import）或 GitHub URL（skills.importUrl）→ 解压到
 *      .chery/.staging/<id>/_raw/，发现含 skill.md 的文件夹 → 候选 + 冲突检测，写 manifest。
 *   2. commit（skills.commit）：按前端选择把 staging 中的文件夹移入 .chery/skills/<name>/，
 *      规范化 skill.md → SKILL.md，清 staging。
 *
 * skill 文件夹名 = sanitize 后目录名（= 未来 skills_dir/<name>，loader 默认 skill 名）。
 * 导入后 loadSkill 实时扫描即见，无需重启。
 */
import { writeFileSync, readFileSync, cpSync, existsSync } from 'fs'
import { join } from 'path'
import type { HandlerContext } from '../message/router.js'
import {
  Method,
  type SkillsImportUrlResponseData,
  type SkillsCommitResponseData,
  type SkillsDeleteResponseData,
  type SkillsCommitRequestData,
  type SkillsPreImportUrlRequestData,
  type SkillsPreImportUrlResponseData,
  type SkillsImportUrlRequestData,
  type SkillStageResult,
  type SkillCandidate,
} from '../message/types.js'
import {
  createStaging,
  removeStaging,
  extractZipBuffer,
  parseGithubUrl,
  findSkillFolders,
  peekSkillMeta,
  sanitizeName,
  skillDirExists,
  skillsDir,
  removeCherySubdir,
  normalizeSkillFileName,
  stagingRoot,
  NAME_PATTERN,
} from './importShared.js'
import { cloneRepo, listRemoteBranches, GitNotInstalledError } from './gitClone.js'
import { isGitAvailable, resolveAuth, resolveInlineAuth } from './credentials.js'
import { upsertSource, removeSkillFromSource, type SkillManifestSource } from './sources.js'

/** staging manifest 单项（含 rawFolder 内部路径，commit 时用）。 */
interface SkillManifestItem {
  name: string
  rawFolder: string
  description: string
  trigger?: string
  conflict: boolean
}
interface SkillManifest {
  kind: 'skill'
  /** git 来源 meta（URL 导入/resync 才有；zip 无）。commit 时据此 upsert 中央来源索引。 */
  source?: SkillManifestSource
  items: SkillManifestItem[]
}

/** staging 目录绝对路径 = stagingRoot()/stagingId。 */
function stagingDirOf(stagingId: string): string {
  return join(stagingRoot(), stagingId)
}

function writeStagingManifest(stagingId: string, manifest: SkillManifest): void {
  writeFileSync(join(stagingDirOf(stagingId), 'manifest.json'), JSON.stringify(manifest), 'utf-8')
}

function readStagingManifest(stagingId: string): SkillManifest {
  const p = join(stagingDirOf(stagingId), 'manifest.json')
  if (!existsSync(p)) throw new Error(`暂存 manifest 不存在（stagingId=${stagingId}），请重新导入`)
  return JSON.parse(readFileSync(p, 'utf-8')) as SkillManifest
}

/**
 * 分析已解压目录，生成候选 + 冲突检测 + 写 manifest。
 * @param source git 来源 meta（URL 导入/resync 传，zip 不传）-- 写入 manifest.source，commit 时据此 upsert 来源索引。
 *   install_skill 仅传 {sourceUrl}（追溯用，不进索引）。
 */
export function analyzeSkillStaging(
  stagingId: string,
  rawDir: string,
  source?: SkillManifestSource,
): SkillStageResult {
  const folders = findSkillFolders(rawDir)
  if (folders.length === 0) {
    removeStaging(stagingId)
    throw new Error(
      '压缩包/仓库中未找到含 skill.md 的文件夹（导入前提：文件夹内至少一个 skill.md）',
    )
  }
  const usedNames = new Set<string>()
  const items: SkillManifestItem[] = []
  const candidates: SkillCandidate[] = []
  for (const f of folders) {
    let name = sanitizeName(f.defaultName)
    if (usedNames.has(name)) {
      let i = 2
      while (usedNames.has(`${name}-${i}`)) i++
      name = `${name}-${i}`
    }
    usedNames.add(name)
    const meta = peekSkillMeta(f.folder)
    const description = meta.description ?? ''
    const trigger = meta.trigger
    const conflict = skillDirExists(name)
    items.push({ name, rawFolder: f.folder, description, trigger, conflict })
    candidates.push({ name, description, trigger, conflict })
  }
  writeStagingManifest(stagingId, { kind: 'skill', source, items })
  return { stagingId, candidates }
}

/** ZIP Buffer → stage（HTTP /api/skills/import 复用；无 git 来源 meta，不写来源索引）。 */
export function stageSkillZipBuffer(buf: Buffer): SkillStageResult {
  const { id, dir } = createStaging()
  const raw = join(dir, '_raw')
  try {
    extractZipBuffer(buf, raw)
    return analyzeSkillStaging(id, raw)
  } catch (err) {
    removeStaging(id)
    throw err
  }
}

/** skills.preImportUrl：解析 URL + 拉 branches + needsAuth/gitNotInstalled 探测（不 clone）。 */
export async function handleSkillsPreImportUrl(
  _ctx: HandlerContext,
  { url, credentialId, proxy }: SkillsPreImportUrlRequestData,
): Promise<SkillsPreImportUrlResponseData> {
  const parsed = parseGithubUrl(url)
  if (!(await isGitAvailable())) {
    return { gitNotInstalled: true, needsAuth: false, branches: [], defaultBranch: undefined }
  }
  const auth = credentialId ? resolveAuth(credentialId) : undefined
  const { branches, defaultBranch, needsAuth } = await listRemoteBranches(
    parsed.gitUrl,
    auth,
    proxy,
  )
  return { gitNotInstalled: false, needsAuth, branches, defaultBranch }
}

/**
 * skills.importUrl：按选定分支 git clone 独立技能集合到 staging 分析候选（对标插件：分支选择 + 鉴权）。
 * 鉴权：credentialId 优先；否则 inline（remember=true 入池）。clone 后带来源 meta 写 manifest（commit 时 upsert 索引）。
 */
export async function handleSkillsImportUrl(
  _ctx: HandlerContext,
  data: SkillsImportUrlRequestData,
): Promise<SkillsImportUrlResponseData> {
  const parsed = parseGithubUrl(data.url)
  const { auth, savedCredentialId } = data.credentialId
    ? { auth: resolveAuth(data.credentialId), savedCredentialId: undefined }
    : resolveInlineAuth(parsed, {
        username: data.username,
        password: data.password,
        remember: data.remember,
        label: data.label,
      })
  const { id, dir } = createStaging()
  const raw = join(dir, '_raw')
  let clone: { dest: string; commitSha: string; commitDate: string }
  try {
    clone = await cloneRepo(parsed.gitUrl, raw, { branch: data.branch, auth, proxy: data.proxy })
  } catch (err) {
    removeStaging(id)
    if (err instanceof GitNotInstalledError) throw err
    if ((err as { needsAuth?: boolean }).needsAuth) {
      throw new Error('Git 鉴权失败：用户名/Token 无效或无权限，请检查凭据后重试')
    }
    throw err
  }
  const result = analyzeSkillStaging(id, raw, {
    cloneUrl: parsed.gitUrl,
    branch: data.branch,
    credentialId: data.credentialId ?? savedCredentialId,
    commitSha: clone.commitSha,
    commitDate: clone.commitDate,
  })
  return {
    stagingId: result.stagingId,
    candidates: result.candidates,
    branch: data.branch,
    commitSha: clone.commitSha,
    commitDate: clone.commitDate,
    savedCredentialId,
  }
}

/** skills.commit：按选择落盘 + 规范化 SKILL.md + 清 staging。manifest 携来源 meta 时 upsert 中央索引。 */
export async function handleSkillsCommit(
  _ctx: HandlerContext,
  { stagingId, selections }: SkillsCommitRequestData,
): Promise<SkillsCommitResponseData> {
  const manifest = readStagingManifest(stagingId)
  const want = new Map(selections.map((s) => [s.name, s.import]))
  const imported: string[] = []
  const skipped: string[] = []
  for (const item of manifest.items) {
    if (want.get(item.name) === false) {
      skipped.push(item.name)
      continue
    }
    const dest = join(skillsDir(), item.name)
    cpSync(item.rawFolder, dest, { recursive: true, force: true })
    normalizeSkillFileName(dest)
    imported.push(item.name)
  }
  // git 来源导入：按 {cloneUrl,branch} 写/更新中央索引（zip 导入 manifest.source 缺，跳过）
  if (manifest.source && manifest.source.cloneUrl && manifest.source.branch) {
    upsertSource(manifest.source, imported)
  }
  removeStaging(stagingId)
  return { imported, skipped }
}

/** skills.delete：删除独立 skill 目录 + 同步从来源索引移除该名（plugins_dir 下的不在此列）。 */
export async function handleSkillsDelete(
  _ctx: HandlerContext,
  { name }: { name: string },
): Promise<SkillsDeleteResponseData> {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(`skill 名 "${name}" 非法（仅允许 [a-zA-Z0-9_-]）`)
  }
  if (!skillDirExists(name)) {
    throw new Error(`skill "${name}" 不存在于 ${skillsDir()}`)
  }
  removeCherySubdir(join(skillsDir(), name))
  removeSkillFromSource(name)
  return { ok: true }
}

/** 注册 Skill 导入/删除 RPC handlers（list 仍由 list.ts 注册；来源管理由 sources.ts 注册）。 */
export function registerSkillImportHandlers(
  router: import('../message/router.js').RpcRouter,
): void {
  router.register(Method.SKILLS_PRE_IMPORT_URL, handleSkillsPreImportUrl)
  router.register(Method.SKILLS_IMPORT_URL, handleSkillsImportUrl)
  router.register(Method.SKILLS_COMMIT, handleSkillsCommit)
  router.register(Method.SKILLS_DELETE, handleSkillsDelete)
}
