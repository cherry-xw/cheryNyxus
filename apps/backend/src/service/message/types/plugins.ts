import type { EmptyObjectData } from '../types.js'

// ========== 插件管理 ==========

/** 插件内 skill 元信息（plugins.list 展示用）。name 为对外名 `<plugin>__<skill>`。
 *  token 字段（nameDescTokens/triggerTokens/contentTokens）与 skill 端 `computeSkillTokens` 同源，
 *  供前端插件卡展示「系统 ≈N」「内容 min–max」+ tag tip。 */
export interface PluginSkillInfo {
  name: string
  description: string
  trigger?: string
  /** name + description 的 token 数（不含 trigger / 正文）。 */
  nameDescTokens: number
  /** trigger 行的 token 数（无 trigger 时为 0）。 */
  triggerTokens?: number
  /** 正文 content 的 token 数。 */
  contentTokens: number
}

/** 插件信息（来源 .chery/plugins/<name>/.chery-plugin.json manifest + 扫描其 skills）。 */
export interface PluginInfo {
  name: string
  sourceUrl: string
  /** 规范化 clone URL（https .git）；旧 manifest 缺失为空串。 */
  cloneUrl: string
  /** 跟踪的分支；旧 manifest 缺失为空串。 */
  branch: string
  /** 安装时的 HEAD 短 SHA；旧 manifest 缺失为空串。 */
  commitSha: string
  /** 安装时的 commit ISO 时间；旧 manifest 缺失为空串。 */
  commitDate: string
  installedAt: string
  updatedAt: string
  /** 最近一次检查更新时间（manifest 持久化）；从未检查为 undefined。 */
  lastCheckedAt?: string
  /** 远端最新 HEAD 短 SHA（最近一次检查写入）；未检查为 undefined。 */
  latestSha?: string
  /** 远端最新 commit ISO（最近一次检查写入）；私有仓 401 或未检查为 undefined。 */
  latestDate?: string
  /** 当前 commitSha 与 latestSha 不一致（最近一次检查写入）；未检查为 undefined。 */
  updateAvailable?: boolean
  /** 最近一次 checkUpdate 错误信息（成功时清除；从未检查或检查成功的为 undefined）。 */
  lastCheckError?: string
  /** 该插件全部 skill 的系统 token 总量（Σ nameDescTokens + triggerTokens）。 */
  totalSystemTokens: number
  /** 该插件 skill 中正文 token 的最小值（无 skill 时为 0）。 */
  minContentTokens: number
  /** 该插件 skill 中正文 token 的最大值（无 skill 时为 0）。 */
  maxContentTokens: number
  skills: PluginSkillInfo[]
}

/** plugins.list：列出已安装插件（.chery/plugins 下各子目录）。 */
export type PluginsListRequestData = EmptyObjectData
export interface PluginsListResponseData {
  plugins: PluginInfo[]
}

/**
 * plugins.preImportUrl：解析 URL + git ls-remote 取分支列表。
 * - needsAuth=true → 私有仓需凭据（前端弹用户名/密码或选凭据池后重试）。
 * - gitNotInstalled=true → 系统 git 缺失（硬性前提），前端禁用导入入口。
 */
export interface PluginsPreImportUrlRequestData {
  url: string
  /** 选中的凭据池 id（私有仓二次尝试时带）；首次省略。 */
  credentialId?: string
  /** 可选 HTTP/HTTPS 代理 URL（如 http://127.0.0.1:7890）；省略 = 直连。 */
  proxy?: string
}
export interface PluginsPreImportUrlResponseData {
  /** 系统 git 缺失（功能不可用，前端据此禁用）。 */
  gitNotInstalled: boolean
  /** 需要鉴权（私有仓）。 */
  needsAuth: boolean
  branches: string[]
  defaultBranch?: string
  owner: string
  repo: string
  /** 建议的插件文件夹名（= sanitizeName(repo)）；前端预填「文件夹名」输入框。 */
  suggestedName: string
  /** 该文件夹名已存在（pluginDirExists）→ 前端展示「文件夹名」输入框供改名。 */
  nameConflict: boolean
}

/**
 * plugins.importUrl：按选定分支 git clone 整仓到 staging 预览（含 existing 冲突）。
 * 鉴权：credentialId（凭据池）优先；否则 inline {username,password}（remember=true 时入池）。
 * credentialId 与 inline password 互斥（schema refine）。
 */
export interface PluginsImportUrlRequestData {
  url: string
  branch: string
  credentialId?: string
  /** inline 入口（与 credentialId 互斥）。 */
  username?: string
  password?: string
  /** 为 true 时把 inline {username,password,label} 加密入池并回填 savedCredentialId。 */
  remember?: boolean
  label?: string
  /**
   * 插件文件夹名覆盖（preImport 返回 nameConflict=true 时由前端提供）。
   * 省略 → 用 sanitizeName(repo)。提供 → 再次 sanitize；与既有文件夹冲突时 existing=true，走 commit overwrite。
   */
  pluginName?: string
  /** 可选 HTTP/HTTPS 代理 URL（如 http://127.0.0.1:7890）；省略 = 直连。 */
  proxy?: string
}
export interface PluginsImportUrlResponseData {
  stagingId: string
  pluginName: string
  existing: boolean
  sourceUrl: string
  branch: string
  commitSha: string
  commitDate: string
  /** remember=true 且新建凭据时回填，供前端刷新凭据池下拉。 */
  savedCredentialId?: string
  skills: PluginSkillInfo[]
}

/** plugins.commit：确认落盘（overwrite=true 则覆盖同名插件）。 */
export interface PluginsCommitRequestData {
  stagingId: string
  overwrite: boolean
}
export interface PluginsCommitResponseData {
  plugin: PluginInfo
}

/**
 * plugins.checkUpdate：对比 manifest 当前 HEAD 与远端分支 HEAD。
 * - updateAvailable = currentSha !== latestSha（currentSha 缺失视为有更新）。
 * - latestDate 私有仓 REST 401 时为 undefined（前端隐藏日期 pill）。
 * - needsAuth=true → 远端需鉴权才能检查（前端提示）。
 */
export interface PluginsCheckUpdateRequestData {
  name: string
}
export interface PluginsCheckUpdateResponseData {
  gitNotInstalled: boolean
  needsAuth: boolean
  currentSha: string
  currentDate: string
  latestSha: string
  latestDate?: string
  /** manifest.updatedAt。 */
  lastUpgrade: string
  updateAvailable: boolean
}

/**
 * plugins.checkAllUpdates：批量检查全部已安装插件的远端 HEAD，结果写入各插件 manifest
 * （lastCheckedAt / latestSha / latestDate / updateAvailable）。前端随后 refresh() 重拉 list 读取。
 * 单个插件检查失败（如私有仓 needsAuth / 网络错误）计入 failed 数组，不中断整体。
 */
export type PluginsCheckAllUpdatesRequestData = EmptyObjectData
export interface PluginsCheckAllUpdatesFailure {
  name: string
  /** 失败原因（needsAuth / 网络错误等），前端可选展示。 */
  reason: string
}
export interface PluginsCheckAllUpdatesResponseData {
  /** 本次实际检查的插件数（含失败）。 */
  checked: number
  /** 检测到有更新的插件数。 */
  updatesAvailable: number
  /** 检查失败的插件（不中断整体）。 */
  failed: PluginsCheckAllUpdatesFailure[]
}

/** plugins.update：按 manifest.cloneUrl+branch 重新 clone 覆盖（保留 pluginName + installedAt）。 */
export interface PluginsUpdateRequestData {
  name: string
}
export interface PluginsUpdateResponseData {
  plugin: PluginInfo
}

/** plugins.uninstall：删除整个插件目录。 */
export interface PluginsUninstallRequestData {
  name: string
}
export interface PluginsUninstallResponseData {
  ok: true
}
