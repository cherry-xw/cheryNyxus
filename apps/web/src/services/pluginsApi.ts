import { call, callList, uploadFile } from './agentApiTransport'
import type { PluginInfo, CredentialListItemDTO, PluginPreImportResult, PluginImportRequest, PluginImportPreview, PluginCheckUpdateResult } from './agentApiTypes'

export const pluginsApi = {
  async listPlugins(): Promise<PluginInfo[]> {
    return callList<PluginInfo>('plugins.list', 'plugins')
  },
  /** plugins.preImportUrl：解析 URL + 拉 branches + needsAuth/gitNotInstalled 探测（不 clone）。 */
  async preImportPluginUrl(
    url: string,
    credentialId?: string,
    proxy?: string,
  ): Promise<PluginPreImportResult> {
    return await call<PluginPreImportResult>('plugins.preImportUrl', {
      url,
      ...(credentialId ? { credentialId } : {}),
      ...(proxy ? { proxy } : {}),
    })
  },
  /** plugins.importUrl：按选定分支 git clone 整仓 → staging 预览（含 existing 冲突 + SHA/日期）。 */
  async importPluginUrl(req: PluginImportRequest): Promise<PluginImportPreview> {
    return await call<PluginImportPreview>('plugins.importUrl', req)
  },
  /** plugins.commit：确认落盘（overwrite=true 覆盖同名插件）。 */
  async commitPlugin(stagingId: string, overwrite: boolean): Promise<{ plugin: PluginInfo }> {
    return await call<{ plugin: PluginInfo }>('plugins.commit', { stagingId, overwrite })
  },
  /** plugins.checkUpdate：对比 manifest 当前 HEAD 与远端分支 HEAD（含最新发布日期，私有仓降级）。 */
  async checkPluginUpdate(name: string): Promise<PluginCheckUpdateResult> {
    return await call<PluginCheckUpdateResult>('plugins.checkUpdate', { name })
  },
  /**
   * plugins.checkAllUpdates：批量检查全部已安装插件，结果写入各自 manifest。
   * 返回 checked / updatesAvailable / failed（单个失败不中断）。调用后需 refresh() 重拉 list 读持久化字段。
   */
  async checkAllPluginsUpdate(): Promise<{
    checked: number
    updatesAvailable: number
    failed: Array<{ name: string; reason: string }>
  }> {
    return await call('plugins.checkAllUpdates', {})
  },
  /** plugins.update：按 manifest.cloneUrl+branch 重新拉取覆盖。 */
  async updatePlugin(name: string): Promise<{ plugin: PluginInfo }> {
    return await call<{ plugin: PluginInfo }>('plugins.update', { name })
  },
  /** plugins.uninstall：删除整个插件目录。 */
  async uninstallPlugin(name: string): Promise<void> {
    await call<{ ok: true }>('plugins.uninstall', { name })
  },

  /** credentials.list：列出全部已存凭据（仅 id/label/username，密令永不回前端）。 */
  async listCredentials(): Promise<CredentialListItemDTO[]> {
    return callList<CredentialListItemDTO>('credentials.list', 'credentials')
  },
  /** credentials.save：加密入池（AES-256-GCM，密令后端解密）。 */
  async saveCredential(
    label: string,
    username: string,
    password: string,
  ): Promise<CredentialListItemDTO> {
    const data = await call<{ credential: CredentialListItemDTO }>('credentials.save', {
      label,
      username,
      password,
    })
    return data.credential
  },
  /** credentials.delete：从凭据池删除。 */
  async deleteCredential(id: string): Promise<void> {
    await call<{ ok: true }>('credentials.delete', { id })
  },

  /** chat.list：stage 只取当前舞台，preset/history 仅在用户显式打开时按需取。 */
}
