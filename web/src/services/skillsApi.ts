import { call, callList, uploadFile } from './agentApiTransport'
import type { SkillInfo, SkillStageResult, SkillCommitSelection, SkillPreImportResult, SkillImportRequest, SkillImportResponse, SkillSource, SkillResyncResult } from './agentApiTypes'

export const skillsApi = {
  async listSkills(params?: {
    page?: number
    pageSize?: number
    search?: string
    plugin?: string
  }): Promise<{ skills: SkillInfo[]; total: number; page: number; pageSize: number }> {
    const data = await call<Record<string, unknown>>('skills.list', params ?? {})
    const skills = Array.isArray(data?.skills) ? (data.skills as SkillInfo[]) : []
    return {
      skills,
      total: (data?.total as number | undefined) ?? skills.length,
      page: (data?.page as number | undefined) ?? 1,
      pageSize: (data?.pageSize as number | undefined) ?? skills.length,
    }
  },

  /** skills.listNames：轻量接口，仅返回 skill/plugin 名称列表（不算 token），供角色卡下拉使用。 */
  async listSkillNames(): Promise<{
    skills: string[]
    plugins: string[]
    skillTokens: Record<string, number>
    pluginTokens: Record<string, number>
  }> {
    return await call('skills.listNames', {})
  },

  /** skills 导入 ZIP：HTTP 上传 raw bytes → stage 候选 + 冲突（两阶段，后 commitSkillImport 落盘）。 */
  async importSkillZip(file: File): Promise<SkillStageResult> {
    return uploadFile<SkillStageResult>('/api/skills/import', file, {
      contentType: 'application/zip',
      errorMessage: 'skill 上传失败',
    })
  },
  /** skills.importUrl：按选定分支 git clone 独立技能集合 → stage 候选 + 冲突（鉴权同插件）。 */
  async importSkillUrl(req: SkillImportRequest): Promise<SkillImportResponse> {
    return await call<SkillImportResponse>('skills.importUrl', req)
  },
  /** skills.commit：按选择落盘 + 规范化 SKILL.md + 清 staging。 */
  async commitSkillImport(
    stagingId: string,
    selections: SkillCommitSelection[],
  ): Promise<{ imported: string[]; skipped: string[] }> {
    return await call<{ imported: string[]; skipped: string[] }>('skills.commit', {
      stagingId,
      selections,
    })
  },
  /** skills.delete：删除独立 skill 目录（插件技能不在此列）。 */
  async deleteSkill(name: string): Promise<void> {
    await call<{ ok: true }>('skills.delete', { name })
  },
  /** skills.preImportUrl：拉分支列表 + needsAuth/gitNotInstalled 探测（不 clone）。 */
  async preImportSkillUrl(
    url: string,
    credentialId?: string,
    proxy?: string,
  ): Promise<SkillPreImportResult> {
    return await call<SkillPreImportResult>('skills.preImportUrl', {
      url,
      ...(credentialId ? { credentialId } : {}),
      ...(proxy ? { proxy } : {}),
    })
  },
  /** skills.listSources：列出 git 来源中央索引（每来源 skills 实时读 skills_dir）。 */
  async listSkillSources(): Promise<SkillSource[]> {
    return callList<SkillSource>('skills.listSources', 'sources')
  },
  async checkSkillSource(sourceId: string): Promise<{
    sourceId: string
    latestSha: string
    latestDate?: string
    updateAvailable: boolean
  }> {
    return await call('skills.checkSource', { sourceId })
  },
  async checkAllSkillSources(): Promise<{
    checked: number
    updatesAvailable: number
    failed: Array<{ sourceId: string; reason: string }>
  }> {
    return await call('skills.checkAllSources', {})
  },
  /** skills.resyncSource：重 clone 某来源 + 重弹候选（前端预勾选原已导入）。 */
  async resyncSkillSource(sourceId: string): Promise<SkillResyncResult> {
    return await call<SkillResyncResult>('skills.resyncSource', { sourceId })
  },
  /** skills.resyncAllSources：批量重拉全部来源（serial 非交互；失败条目写 lastSyncError 持久化）。 */
  async resyncAllSkillSources(): Promise<{
    results: Array<{
      sourceId: string
      ok: boolean
      error?: string
      commitSha?: string
      commitDate?: string
    }>
    successes: number
    failures: number
  }> {
    return await call('skills.resyncAllSources', {})
  },
  /** skills.deleteSource：删来源条目 + 其跟踪的 skill 文件夹。 */
  async deleteSkillSource(sourceId: string): Promise<void> {
    await call<{ ok: true }>('skills.deleteSource', { sourceId })
  },

  /** plugins.list：列出已安装插件（.chery/plugins/*）。 */
}
