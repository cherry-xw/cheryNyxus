import type { EmptyObjectData } from '../types.js'

/** skills.list 响应：用户 `.chery/skills/` 独立 skill + `.chery/plugins/` 插件 skill；不含前端内置命令。
 *  只返回 frontmatter 元数据与 token 估算，不返回技能正文 content（列表接口仅用于展示/搜索）。 */
export interface SkillsListResponseData {
  skills: Array<{
    name: string
    description: string
    trigger?: string
    /** SKILL.md frontmatter 中用户自定义字段（version 等），key 为原字段名。 */
    extra?: Record<string, unknown>
    /** 激活该技能后写入模型上下文的近似 token 增量（= 系统提示词 + 内容提示词之和）。 */
    contextTokens: number
    /** 系统提示词占用：注入 system prompt `<skills>` XML 的 name+description token。 */
    nameDescTokens: number
    /** 系统提示词占用：trigger 行 token（可选，无 trigger 则省略）。 */
    triggerTokens?: number
    /** 内容提示词占用：激活后加载的技能正文 token。 */
    contentTokens: number
    /** JSON 序列化全字段（含 extra）的 token（按设计用作正文段 token 计算）。 */
    promptTokens?: number
    /** 来源插件名（undefined = 独立 skill；否则为插件 skill，name 形如 `<plugin>__<skill>`）。 */
    plugin?: string
  }>
  /** 匹配条件总条数（分页时前端需要知道总数）。无分页时等于 skills.length。 */
  total: number
  /** 当前页码（1-based）；无分页时为 1。 */
  page: number
  /** 每页条数；无分页时为 skills.length。 */
  pageSize: number
}

/** skills.listNames：轻量接口，仅返回全部 skill 名称（不算 token），供角色卡下拉使用。 */
export type SkillsListNamesRequestData = EmptyObjectData
export interface SkillsListNamesResponseData {
  /** 全部独立 skill 名。 */
  skills: string[]
  /** 全部插件名。 */
  plugins: string[]
  /** 角色装备摘要用的系统提示词 token，不读取技能正文。 */
  skillTokens: Record<string, number>
  pluginTokens: Record<string, number>
}

/** 导入候选 skill（两阶段导入的 stage 产物）。 */
export interface SkillCandidate {
  /** sanitize 后的 skill 目录名（= 未来 skills_dir/<name>）。 */
  name: string
  description: string
  trigger?: string
  /** skills_dir/<name> 已存在 → 冲突，需前端逐项确认覆盖/跳过。 */
  conflict: boolean
}

/** skills 导入 stage 结果（HTTP /api/skills/import 与 skills.importUrl 共用）。 */
export interface SkillStageResult {
  stagingId: string
  candidates: SkillCandidate[]
}

/** skills.preImportUrl：解析 URL + git ls-remote 取分支列表 + 鉴权/git 探测（不 clone）。 */
export interface SkillsPreImportUrlRequestData {
  url: string
  /** 选中凭据池 id（私有仓二次尝试时带）；首次省略。 */
  credentialId?: string
  /** 可选 HTTP/HTTPS 代理 URL（如 http://127.0.0.1:7890）；省略 = 直连。 */
  proxy?: string
}
export interface SkillsPreImportUrlResponseData {
  /** 系统 git 缺失（功能不可用，前端据此禁用）。 */
  gitNotInstalled: boolean
  /** 需要鉴权（私有仓）。 */
  needsAuth: boolean
  branches: string[]
  defaultBranch?: string
}

/**
 * skills.importUrl：按选定分支 git clone 独立技能集合到 staging 分析候选（对标插件：分支选择 + 鉴权）。
 * 鉴权：credentialId（凭据池）优先；否则 inline {username,password}（remember=true 时入池）。互斥。
 */
export interface SkillsImportUrlRequestData {
  url: string
  branch: string
  credentialId?: string
  /** inline 入口（与 credentialId 互斥）。 */
  username?: string
  password?: string
  /** 为 true 时把 inline {username,password,label} 加密入池并回填 savedCredentialId。 */
  remember?: boolean
  label?: string
  /** 可选 HTTP/HTTPS 代理 URL（如 http://127.0.0.1:7890）；省略 = 直连。 */
  proxy?: string
}
export interface SkillsImportUrlResponseData extends SkillStageResult {
  /** 选中分支（URL 导入才有；zip 上传无）。 */
  branch?: string
  /** HEAD 短 SHA（URL 导入才有）。 */
  commitSha?: string
  /** HEAD 提交时间 ISO（URL 导入才有）。 */
  commitDate?: string
  /** inline + remember 成功入池时回填的新凭据 id。 */
  savedCredentialId?: string
}

/** skills.commit 单项选择：import=false → 跳过；true → 导入（冲突则覆盖）。 */
export interface SkillCommitSelection {
  name: string
  import: boolean
}
export interface SkillsCommitRequestData {
  stagingId: string
  selections: SkillCommitSelection[]
}
export interface SkillsCommitResponseData {
  imported: string[]
  skipped: string[]
}

/** skills.delete：删除独立 skill 目录（plugins_dir 下的插件 skill 不在此列）。 */
export interface SkillsDeleteRequestData {
  name: string
}
export interface SkillsDeleteResponseData {
  ok: true
}

/** git 来源索引项（.chery/.skill-sources.json 单条；按 {cloneUrl,branch} 分组）。 */
export interface SkillSourceEntry {
  /** 稳定 id = sha1(cloneUrl+branch) 前 12 位。 */
  id: string
  /** 规范化 https clone URL。 */
  cloneUrl: string
  branch: string
  /** 关联凭据池 id（re-sync 时复用；未存则 undefined）。 */
  credentialId?: string
  /** 上次同步时的 HEAD 短 SHA。 */
  commitSha: string
  /** 上次同步时的 HEAD 提交时间 ISO。 */
  commitDate: string
  /** 上次同步时间 ISO。 */
  lastSyncedAt: string
  /** 最近一次 resyncAllSources 错误信息（成功时清除；从未批量刷新或非失败结果为 undefined）。 */
  lastSyncError?: string
  lastCheckedAt?: string
  latestSha?: string
  latestDate?: string
  updateAvailable?: boolean
  lastCheckError?: string
  /** 跟踪的 skill 文件夹名（skills_dir 下的目录名）。 */
  skills: string[]
}
/** skills.listSources 返回项：仓库摘要，不展开关联技能。 */
export interface SkillSourceDTO extends Omit<SkillSourceEntry, 'skills'> {
  skillCount: number
}
/** skills.listSources：列出 git 来源中央索引。 */
export type SkillsListSourcesRequestData = EmptyObjectData
export interface SkillsListSourcesResponseData {
  sources: SkillSourceDTO[]
}
export interface SkillsCheckSourceRequestData {
  sourceId: string
}
export interface SkillsCheckSourceResponseData {
  sourceId: string
  latestSha: string
  latestDate?: string
  updateAvailable: boolean
}
export type SkillsCheckAllSourcesRequestData = EmptyObjectData
export interface SkillsCheckAllSourcesResponseData {
  checked: number
  updatesAvailable: number
  failed: Array<{ sourceId: string; reason: string }>
}
/** skills.resyncSource：重 clone 某来源 + 重分析候选（前端重弹候选列表预勾选）。 */
export interface SkillsResyncSourceRequestData {
  sourceId: string
}
export interface SkillsResyncSourceResponseData extends SkillStageResult {
  branch: string
  commitSha: string
  commitDate: string
  sourceId: string
  /** 该来源原先跟踪的技能，前端默认继续勾选。 */
  selected: string[]
}
/** skills.deleteSource：删来源索引条目 + 其跟踪的 skill 文件夹。 */
export interface SkillsDeleteSourceRequestData {
  sourceId: string
}
export interface SkillsDeleteSourceResponseData {
  ok: true
}
/**
 * skills.resyncAllSources：批量重拉全部来源（非交互）。
 * 自动 commit 仅匹配原 entry.skills 命名的 candidate；新增/删除静默丢弃（避免与手动 resyncSource 行为交叉）。
 * 失败条目同步写入 SkillSourceEntry.lastSyncError 便于下次刷新前展示「刷新失败」红 pill。
 */
export type SkillsResyncAllSourcesRequestData = EmptyObjectData
export interface SkillsResyncAllSourcesEntry {
  sourceId: string
  ok: boolean
  /** 失败时附带错误信息（鉴权/网络/git 缺失等）。 */
  error?: string
  /** 成功时新 HEAD SHA。 */
  commitSha?: string
  /** 成功时新 HEAD commit 时间 ISO。 */
  commitDate?: string
}
export interface SkillsResyncAllSourcesResponseData {
  results: SkillsResyncAllSourcesEntry[]
  successes: number
  failures: number
}
