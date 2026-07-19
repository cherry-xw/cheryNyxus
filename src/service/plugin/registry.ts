/**
 * 插件 manifest 读写（.chery/plugins/<name>/.chery-plugin.json）。
 *
 * manifest 记录插件来源 URL 与安装/更新时间，供 plugins.update（重新拉取）与 list 展示。
 * 自包含：每个插件目录内独立 manifest，无需全局注册表。
 */
import { writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { pluginsDir } from '../skill/importShared.js'

export const MANIFEST_FILE = '.chery-plugin.json'

export interface PluginManifest {
  name: string
  sourceUrl: string
  /** 规范化 clone URL（https .git）；旧 manifest 缺失→""。 */
  cloneUrl: string
  /** 跟踪分支；旧 manifest 缺失→""（checkUpdate 时从 sourceUrl 派生）。 */
  branch: string
  /** 安装时 HEAD SHA；旧 manifest 缺失→""（视为有更新）。 */
  commitSha: string
  /** 安装时 commit ISO；旧 manifest 缺失→""。 */
  commitDate: string
  installedAt: string
  updatedAt: string
  /** 最近一次 checkUpdate 时间 ISO；从未检查→undefined。list 透传供前端展示「上次检查」。 */
  lastCheckedAt?: string
  /** 远端最新 HEAD 短 SHA（最近一次 checkUpdate 写入）；未检查→undefined。 */
  latestSha?: string
  /** 远端最新 commit ISO（最近一次 checkUpdate 写入）；私有仓 401 或未检查→undefined。 */
  latestDate?: string
  /** commitSha !== latestSha（最近一次 checkUpdate 写入）；未检查→undefined。前端据此显隐 refresh 按钮。 */
  updateAvailable?: boolean
  /** 最近一次 checkUpdate 错误信息（成功时清除；从未检查或检查成功的为 undefined）。 */
  lastCheckError?: string
}

export function pluginDir(name: string): string {
  return join(pluginsDir(), name)
}

/**
 * 读取 manifest；旧 manifest（缺 cloneUrl/branch/commitSha/commitDate）字段补 ""。
 * 解析失败返回 undefined。
 */
export function readManifest(name: string): PluginManifest | undefined {
  const p = join(pluginDir(name), MANIFEST_FILE)
  if (!existsSync(p)) return undefined
  let raw: Partial<PluginManifest>
  try {
    raw = JSON.parse(readFileSync(p, 'utf-8')) as Partial<PluginManifest>
  } catch {
    return undefined
  }
  return {
    name: raw.name ?? '',
    sourceUrl: raw.sourceUrl ?? '',
    cloneUrl: raw.cloneUrl ?? '',
    branch: raw.branch ?? '',
    commitSha: raw.commitSha ?? '',
    commitDate: raw.commitDate ?? '',
    installedAt: raw.installedAt ?? '',
    updatedAt: raw.updatedAt ?? '',
    lastCheckedAt: raw.lastCheckedAt,
    latestSha: raw.latestSha,
    latestDate: raw.latestDate,
    updateAvailable: raw.updateAvailable,
    lastCheckError: raw.lastCheckError,
  }
}

export function writeManifest(name: string, manifest: PluginManifest): void {
  writeFileSync(join(pluginDir(name), MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf-8')
}
