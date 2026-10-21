import { computed, reactive } from 'vue'
import {
  IngressHttpResponseSchemas,
  type IngressCapability,
  type ManagerUiRegistration,
  type IngressListResult,
} from '../../../packages/protocol/src/ingress'
import { managerRequest, ManagerApiError } from '../../../packages/manager-ui/src/api'
import { requestId } from '../../../packages/manager-ui/src/requestId'
export function usePlugins(request = managerRequest) {
  const state = reactive({
    list: null as IngressListResult | null,
    modules: [] as ManagerUiRegistration[],
    reading: false,
    writing: false,
    uncertain: false,
    error: '',
    message: '',
    packagePath: '',
    digest: '',
    grants: [] as IngressCapability[],
    channel: '',
    credentialKind: '',
  })
  const ready = computed(
    () => state.list !== null && !state.reading && !state.writing && !state.uncertain,
  )
  const config = reactive({
    id: '',
    text: '',
    revision: null as number | null,
    apply: '',
    dirty: false,
  })
  async function readConfig(id: string) {
    if (!ready.value || (config.dirty && !window.confirm('重新读取会替换未保存配置，确认继续？')))
      return
    try {
      const result = IngressHttpResponseSchemas.config.parse(
        await request(`/api/plugins/${id}/config`),
      ).data
      config.id = id
      config.text = JSON.stringify(result.config, null, 2)
      config.revision = result.baseRevision
      config.apply = result.apply.state
      config.dirty = false
    } catch (error) {
      state.error = error instanceof Error ? error.message : '配置读取失败'
    }
  }
  async function saveConfig() {
    if (!ready.value || config.revision === null) return
    let value: unknown
    try {
      value = JSON.parse(config.text)
    } catch {
      state.error = '配置必须是有效 JSON'
      return
    }
    state.writing = true
    try {
      const result = IngressHttpResponseSchemas.configSave.parse(
        await request(`/api/plugins/${config.id}/config`, {
          method: 'PUT',
          body: JSON.stringify({
            contractVersion: 2,
            config: value,
            expectedBaseRevision: config.revision,
            requestId: requestId(),
          }),
        }),
      ).data
      config.text = JSON.stringify(result.config, null, 2)
      config.revision = result.baseRevision
      config.apply = result.apply.state
      config.dirty = false
      state.message = '配置已保存并回读确认。'
    } catch (error) {
      state.error = error instanceof Error ? error.message : '保存未确认'
      config.revision = null
      state.uncertain = true
    } finally {
      state.writing = false
    }
  }
  async function read() {
    if (state.writing || state.reading) return
    state.reading = true
    state.error = ''
    try {
      const list = IngressHttpResponseSchemas.list.parse(await request('/api/plugins')).data
      let modules: ManagerUiRegistration[] = []
      if (!list.backendUnavailable) {
        try {
          modules = IngressHttpResponseSchemas.modules.parse(await request('/api/modules')).data
            .modules
        } catch {
          modules = []
        }
      }
      state.list = list
      state.modules = modules
      state.uncertain = false
    } catch (error) {
      state.list = null
      state.modules = []
      state.error = error instanceof Error ? error.message : '插件目录读取失败'
    } finally {
      state.reading = false
    }
  }
  async function mutate(
    action: 'install' | 'upgrade' | 'enable' | 'disable' | 'uninstall',
    id?: string,
  ) {
    if (!ready.value || !state.list) return
    state.writing = true
    state.error = ''
    state.message = ''
    const body = {
      contractVersion: 2,
      expectedRegistryRevision: state.list.registryRevision,
      requestId: requestId(),
      ...(id
        ? {}
        : {
            packagePath: state.packagePath,
            expectedDigest: state.digest,
            grantedCapabilities: [...state.grants],
            channelGrants:
              state.grants.includes('channel.identity') && (state.channel || state.credentialKind)
                ? [{ channel: state.channel, credentialKind: state.credentialKind }]
                : [],
          }),
    }
    try {
      IngressHttpResponseSchemas.mutation.parse(
        await request(`/api/plugins/${id ? `${id}/` : ''}${action}`, {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      )
      state.message =
        action === 'uninstall'
          ? '已卸载并回读确认，配置与长期数据保留。'
          : '已保存并回读确认；活动状态与需重启提示请查看下方。'
    } catch (error) {
      state.error = error instanceof Error ? error.message : '插件操作失败'
      state.uncertain =
        !(error instanceof ManagerApiError) || ![400, 403, 401, 409].includes(error.status)
    } finally {
      state.writing = false
    }
    if (!state.uncertain) await read()
  }
  return { state, ready, read, mutate, config, readConfig, saveConfig }
}
