import { computed, reactive, watch, onScopeDispose } from 'vue'
import { SettingsBrainSchema } from '../../../packages/protocol/src/settings'
import { SETTINGS_UNSET_FIELDS } from '../../../packages/protocol/src/settingsValues'
import { effectiveLlmBaseUrl, effectiveLlmProtocol, httpAddressError, llmRequiresKey } from '../../../packages/protocol/src/llmConnection'
import { mergeBrainCapabilities } from '../../../packages/protocol/src/brainCapabilities'
import { LLM_PROTOCOL_CATALOG } from '../../../packages/protocol/src/llm'
import { managerRequest, ManagerApiError } from '../../../packages/manager-ui/src/api'
import { requestId } from '../../../packages/manager-ui/src/requestId'
import type { CapabilityCatalog, ResourceKind, ResourceView } from '../src/contracts'
import type { z } from 'zod'
import type { SettingsModelsResultSchema, SettingsModelRecommendationResultSchema } from '../../../packages/protocol/src/settings'
type UtilsModelsResponseData = z.infer<typeof SettingsModelsResultSchema>
type UtilsModelRecommendationResponseData = z.infer<typeof SettingsModelRecommendationResultSchema>

export const protocols = LLM_PROTOCOL_CATALOG
const defaults = (kind: ResourceKind): any =>
  kind === 'brains'
    ? {
        provider: 'custom',
        protocol: 'openai-chat-completions',
        model: '',
      }
    : kind === 'sense-groups'
      ? []
      : { brain: '', senseGroup: '' }
const newEditor = (kind: ResourceKind) => ({
  selected: '',
  name: '',
  value: defaults(kind),
  key: '',
  revision: '',
  loading: false,
  saving: false,
  error: '',
  message: '',
  uncertain: false,
  keyConfigured: false,
  baseline: {} as Record<string, unknown>,
  keyRemoved: false,
  generation: 0,
})

export function useCapabilities(request = managerRequest) {
  const state = reactive({
    catalog: {
      brains: [],
      senseGroups: [],
      presets: [],
      tools: [],
      baseRevision: '',
    } as CapabilityCatalog,
    loading: false,
    error: '',
    ready: false,
    writing: false,
  })
  const editors = reactive({
    brains: newEditor('brains'),
    'sense-groups': newEditor('sense-groups'),
    presets: newEditor('presets'),
  })
  const model = reactive({
    options: [] as UtilsModelsResponseData['models'],
    loading: false,
    error: '',
    recommendation: null as UtilsModelRecommendationResponseData | null,
    identifying: false,
    notice: '',
    automatic: true,
  })
  let modelGeneration = 0
  let recommendationGeneration = 0
  const choices = (kind: ResourceKind) =>
    kind === 'brains'
      ? state.catalog.brains
      : kind === 'sense-groups'
        ? state.catalog.senseGroups
        : state.catalog.presets
  const availableTools = computed(() =>
    state.catalog.tools.filter(
      (tool) =>
        !tool.unavailableReason &&
        !editors['sense-groups'].value.some(
          (entry: string) => entry.split(':')[0]?.trim() === tool.name.trim(),
        ),
    ),
  )
  const thinkingLevels = computed(() => model.recommendation?.thinkingLevels ?? [])
  const effectiveCapabilities = computed(() => mergeBrainCapabilities(undefined, model.recommendation?.recommend?.capabilities, model.recommendation?.facts?.capabilities))
  const effectiveProtocol = computed(() => effectiveLlmProtocol(editors.brains.value))
  const defaultAddress = computed(() => effectiveLlmBaseUrl({ ...editors.brains.value, url: undefined }) ?? '无默认地址，必须填写')
  const modelBlockedBy = computed(() => {
    const brain = editors.brains.value
    const url = effectiveLlmBaseUrl(brain)
    if (!effectiveProtocol.value) return '请先选择有效协议'
    if (!url?.startsWith('$') && httpAddressError(url)) return '请填写有效地址'
    if (llmRequiresKey(brain) && !editors.brains.key.trim() && (!editors.brains.keyConfigured || editors.brains.keyRemoved)) return '请填写密钥'
    return ''
  })
  function resetField(kind: ResourceKind, field: string) {
    if (field === 'key' && kind === 'brains') { editors.brains.key = ''; editors.brains.keyRemoved = true; return }
    delete editors[kind].value[field]
  }
  function adoptContextLimit() {
    const recommended = model.recommendation?.recommend?.contextLimit
    if (recommended) editors.brains.value.contextLimit = recommended
  }
  const toolName = (entry: string) => entry.split(':')[0]?.trim() ?? entry
  const toolInfo = (entry: string) =>
    state.catalog.tools.find((tool) => tool.name === toolName(entry))
  const busy = (kind: ResourceKind) =>
    editors[kind].loading || editors[kind].saving || state.writing

  async function loadCatalog() {
    state.loading = true
    state.error = ''
    try {
      state.catalog = (
        await request<{ data: CapabilityCatalog }>('/api/modules/capabilities/catalog')
      ).data
      state.ready = true
      for (const kind of ['brains', 'sense-groups', 'presets'] as const) {
        // Refreshing the directory must not silently rebase an existing draft.
        if (!editors[kind].revision) editors[kind].revision = state.catalog.baseRevision
      }
    } catch (error) {
      state.ready = false
      state.error = error instanceof Error ? error.message : '目录读取失败'
    } finally {
      state.loading = false
    }
  }
  function accept(kind: ResourceKind, view: ResourceView) {
    const editor = editors[kind]
    editor.value = view.value
    editor.baseline = JSON.parse(JSON.stringify(view.value))
    editor.keyRemoved = false
    editor.name = view.name
    editor.selected = view.name
    editor.revision = view.baseRevision
    editor.key = ''
    editor.keyConfigured = view.secrets?.keyConfigured === true
    editor.uncertain = false
    const status =
      view.apply.status === 'applied'
        ? '已应用'
        : view.apply.status === 'pending'
          ? '待应用'
          : '应用失败'
    editor.message = `已回读确认 · ${status}${view.apply.restart.required ? ' · 需要重启后端' : ''}`
  }
  async function openResource(kind: ResourceKind) {
    const editor = editors[kind]
    const selected = editor.selected
    const generation = ++editor.generation
    editor.error = ''
    editor.message = ''
    editor.key = ''
    editor.loading = false
    editor.uncertain = false
    if (kind === 'brains') {
      modelGeneration++
      recommendationGeneration++
      model.options = []
      model.error = ''
      model.recommendation = null
      model.automatic = false
    }
    if (!selected) {
      editor.name = ''
      editor.value = defaults(kind)
      editor.baseline = {}
      editor.keyRemoved = false
      editor.revision = state.catalog.baseRevision
      editor.keyConfigured = false
      if (kind === 'brains') model.automatic = true
      return
    }
    editor.loading = true
    try {
      const result = await request<{ data: ResourceView }>(
        `/api/modules/capabilities/resources/${kind}?name=${encodeURIComponent(selected)}`,
      )
      if (generation === editor.generation) accept(kind, result.data)
    } catch (error) {
      if (generation === editor.generation) {
        editor.error = error instanceof Error ? error.message : '资源读取失败'
        editor.uncertain = true
      }
    } finally {
      if (generation === editor.generation) editor.loading = false
    }
  }
  async function saveResource(kind: ResourceKind) {
    const editor = editors[kind]
    if (busy(kind) || !state.ready || editor.uncertain) return
    editor.error = ''
    editor.message = ''
    if (!editor.name.trim()) {
      editor.error = '请填写资源名称'
      return
    }
    if (!editor.selected && choices(kind).includes(editor.name.trim())) {
      editor.error = '同名资源已存在，请从上方选择编辑'
      return
    }
    if (kind === 'brains') {
      const result = SettingsBrainSchema.safeParse(editor.value)
      if (!result.success) { editor.error = result.error.issues.map(issue => `llm.brain.${editor.name}.${issue.path.join('.')}: ${issue.message}`).join('\n'); return }
      if (modelBlockedBy.value && effectiveProtocol.value !== 'mock') { editor.error = modelBlockedBy.value; return }
    }
    if (
      kind === 'presets' &&
      (!state.catalog.brains.includes(editor.value.brain) ||
        (editor.value.senseGroup && !state.catalog.senseGroups.includes(editor.value.senseGroup)))
    ) {
      editor.error = '引用资源不存在，请重新选择已保存模型和工具组'
      return
    }

    editor.saving = true
    state.writing = true
    try {
      const value =
        kind === 'sense-groups'
          ? [...editor.value]
           : { ...editor.value, ...(kind === 'brains' && editor.key ? { key: editor.key } : {}) }
      const unset = (SETTINGS_UNSET_FIELDS[kind] as readonly string[]).filter(field => Object.hasOwn(editor.baseline, field) && !Object.hasOwn(value, field))
      if (kind === 'brains' && editor.keyRemoved && !editor.key) unset.push('key')
      const result = await request<{ data: ResourceView }>(
        `/api/modules/capabilities/resources/${kind}`,
        {
          method: editor.selected ? 'PUT' : 'POST',
          body: JSON.stringify({
            name: editor.name.trim(),
            ...(editor.selected ? { originalName: editor.selected } : {}),
            value,
            ...(unset.length ? { unset } : {}),
            expectedBaseRevision: editor.revision,
            requestId: requestId(),
          }),
        },
      )
      const previousRevision = editor.revision
      accept(kind, result.data)
      // Our own write changed only this resource; untouched peer drafts can follow it.
      for (const peer of ['brains', 'sense-groups', 'presets'] as const) {
        if (peer !== kind && editors[peer].revision === previousRevision)
          editors[peer].revision = result.data.baseRevision
      }
      await loadCatalog()
    } catch (error) {
      editor.error = error instanceof Error ? error.message : '保存失败，请回读核对'
      editor.uncertain =
        !(error instanceof ManagerApiError) || ![400, 401, 403, 404, 422].includes(error.status)
      if (kind === 'brains') editor.key = ''
    } finally {
      editor.saving = false
      state.writing = false
    }
  }
  async function deleteResource(kind: ResourceKind) {
    const editor = editors[kind]
    if (busy(kind) || !editor.selected || editor.uncertain || !state.ready) return
    if (!window.confirm(`确定删除“${editor.selected}”？此操作不可撤销。`)) return
    editor.error = ''
    editor.message = ''
    editor.saving = true
    state.writing = true
    try {
      const result = await request<{ data: { baseRevision: string } }>(
        `/api/modules/capabilities/resources/${kind}`,
        {
          method: 'DELETE',
          body: JSON.stringify({
            name: editor.selected,
            expectedBaseRevision: editor.revision,
            requestId: requestId(),
          }),
        },
      )
      const previous = editor.revision
      editor.selected = ''
      editor.name = ''
      editor.value = defaults(kind)
      editor.key = ''
      editor.keyConfigured = false
      editor.revision = result.data.baseRevision
      for (const peer of ['brains', 'sense-groups', 'presets'] as const)
        if (editors[peer].revision === previous) editors[peer].revision = result.data.baseRevision
      await loadCatalog()
      editor.message = '已删除并回读确认'
    } catch (error) {
      editor.error = error instanceof Error ? error.message : '删除结果无法确认，请刷新核对'
      editor.uncertain =
        !(error instanceof ManagerApiError) || ![400, 401, 403, 404, 422].includes(error.status)
    } finally {
      editor.saving = false
      state.writing = false
    }
  }
  async function readBack(kind: ResourceKind) {
    const editor = editors[kind]
    editor.selected = editor.selected || editor.name.trim()
    await loadCatalog()
    await openResource(kind)
  }
  async function fetchModels() {
    const editor = editors.brains
    if (modelBlockedBy.value) {
      model.error = modelBlockedBy.value
      return
    }
    const generation = ++modelGeneration
    model.loading = true
    model.error = ''
    model.options = []
    try {
      const result = await request<{ data: UtilsModelsResponseData }>(
        '/api/modules/capabilities/models',
        {
          method: 'POST',
          body: JSON.stringify({
             ...(editor.selected && editor.keyConfigured && !editor.key && !editor.keyRemoved
               ? { savedBrain: editor.selected, expectedBaseRevision: editor.revision }
              : {}),
            provider: editor.value.provider,
            protocol: editor.value.protocol,
            url: editor.value.url,
            fullUrl: editor.value.fullUrl === true,
            ...(editor.key ? { key: editor.key } : {}),
          }),
        },
      )
      if (generation !== modelGeneration) return
      model.options = result.data.models
      if (!model.options.length) model.error = '服务未返回模型，请检查 URL 和 Key'
    } catch (error) {
      if (generation === modelGeneration)
        model.error =
          error instanceof ManagerApiError
            ? error.message
            : '获取模型列表失败，请检查 URL 和 Key，以及后端连接和凭据。'
    } finally {
      if (generation === modelGeneration) model.loading = false
    }
  }
   async function identify(applyProtocol = false) {
    const generation = ++recommendationGeneration
    model.recommendation = null
    model.notice = ''
    model.identifying = false
    const value = editors.brains.value
    if (!value.model) return
    model.identifying = true
    try {
      const result = await request<{ data: UtilsModelRecommendationResponseData }>(
        '/api/modules/capabilities/model-recommendation',
        {
          method: 'POST',
          body: JSON.stringify({
            model: value.model,
            provider: value.provider,
            protocol: value.protocol,
          }),
        },
      )
      if (generation !== recommendationGeneration) return
      model.recommendation = result.data
      const recommended = result.data.recommend?.protocol
      if (
         applyProtocol && model.automatic &&
        recommended &&
        protocols.some((protocol) => protocol.id === recommended) &&
        recommended !== value.protocol
      ) {
        value.protocol = recommended
        return
      }
      model.notice = result.data.matched
        ? `后端识别：${result.data.id ?? '已匹配模型规则'}；推荐协议：${recommended ?? '未指定'}`
        : '后端未匹配模型规则，请在 model-catalog.yaml 配置该模型的思考档位。'
    } catch {
      if (generation === recommendationGeneration)
        model.notice = '模型识别不可用，仍可手动配置；实际支持以模型服务为准。'
    } finally {
      if (generation === recommendationGeneration) model.identifying = false
    }
  }
  function addTool(name: string) {
    if (availableTools.value.some((tool) => tool.name === name))
      editors['sense-groups'].value.push(`${name}:auto`)
  }
  watch(
    () => [
      editors.brains.value.model,
      editors.brains.value.protocol,
      editors.brains.value.provider,
      editors.brains.value,
    ],
    (current, previous) => void identify(!!previous && current[3] === previous[3] && current[0] !== previous[0] && !editors.brains.loading),
  )
  watch(
    () => [editors.brains.value, editors.brains.value.url, editors.brains.value.provider, editors.brains.value.protocol, editors.brains.value.fullUrl, editors.brains.key, editors.brains.revision, editors.brains.selected],
    () => {
      modelGeneration++
      model.options = []
      model.error = ''
      model.loading = false
    },
  )
  function clearSecrets() {
    editors.brains.key = ''
    modelGeneration++; recommendationGeneration++
    model.recommendation = null; model.options = []
  }
  onScopeDispose(() => { modelGeneration++; recommendationGeneration++ })
  return {
    state,
    editors,
    model,
    choices,
    availableTools,
    thinkingLevels,
    toolName,
    toolInfo,
    busy,
    loadCatalog,
    openResource,
    saveResource,
    deleteResource,
    readBack,
    fetchModels,
    identify,
    addTool,
    clearSecrets,
    effectiveCapabilities, effectiveProtocol, defaultAddress, modelBlockedBy, resetField, adoptContextLimit,
  }
}
