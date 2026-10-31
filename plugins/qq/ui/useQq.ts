import { requestId } from '../../../packages/manager-ui/src/requestId'
import { computed, reactive } from 'vue'
import { managerRequest, ManagerApiError } from '../../../packages/manager-ui/src/api'
import { QQConfigSchema, QQEntriesSchema, QQEntryDetailSchema, type QQEntry, type QQEntryDetail } from '../../../packages/protocol/src/qq'
import { useQqSources } from './useQqSources'

export function useQq(request = managerRequest) {
  const state = reactive({ config: null as any, original: '', revision: 0, apply: null as any, ready: false, reading: false, saving: false, uncertain: false, error: '', message: '', catalog: null as any, catalogError: '', status: null as any, statusError: '', queue: null as { entries: QQEntry[] } | null, queueError: '', history: null as { entries: QQEntry[] } | null, historyError: '', queueLoading: false, historyLoading: false, statusLoading: false, recordsRevision: 0, details: {} as Record<string, QQEntryDetail>, detailErrors: {} as Record<string, string>, detailsLoading: {} as Record<string, boolean>, voiceGroup: '', voices: [] as Array<{id: string; name: string}>, voicesLoading: false, voicesError: '', selected: '', summary: '', summaryError: '' })
  const dirty = computed(() => state.config !== null && JSON.stringify(state.config) !== state.original)
  const targets = computed(() => state.config ? [...state.config.groups.map((id: string) => `group:${id}`), ...state.config.users.map((id: string) => `private:user:${id}`)] : [])
  let summaryGeneration = 0
  const detailRevisions = new Map<string, number>()
  let readGeneration=0
  const recordReads=new Set<AbortController>()
  function clearDetails(){readGeneration++;for(const controller of recordReads)controller.abort();recordReads.clear();state.recordsRevision++;state.details={};state.detailErrors={};state.detailsLoading={};state.queue=null;state.history=null;detailRevisions.clear()}
  const sources=useQqSources(request,clearDetails)
  const openRecords=reactive<Record<string,boolean>>({})
  function dispose(){clearDetails();sources.clear();for(const id of Object.keys(openRecords))delete openRecords[id]}
  function denied(error:unknown){if(error instanceof ManagerApiError&&[401,403].includes(error.status)){clearDetails();sources.clear()}}
  async function read(discard = false) {
    if (state.saving || state.reading) return
    state.reading = true; state.error = ''
    const draft = JSON.stringify(state.config)
    try {
      const { data } = await request<any>('/api/modules/qq/config')
      if (!QQConfigSchema.safeParse(data?.config).success || !Number.isSafeInteger(data.baseRevision)) throw new Error('QQ 配置响应不完整，不能当作空配置。')
      if (JSON.stringify(state.config) !== draft || (dirty.value && !discard)) { state.message = '最新配置已读取；为保护草稿未覆盖，请明确选择重新读取。'; return }
      state.config = data.config; state.original = JSON.stringify(data.config); state.revision = data.baseRevision; state.apply = data.apply; state.ready = true; state.uncertain = false
      state.message = `已读取保存版本 ${data.baseRevision}`
    } catch (e) { denied(e);state.error = e instanceof Error ? e.message : 'QQ 配置读取失败'; state.ready = false }
    finally { state.reading = false }
  }
  async function catalog() {
    try { state.catalog = (await request<any>('/api/modules/capabilities/catalog')).data; state.catalogError = '' }
    catch (e) { denied(e);state.catalogError = e instanceof Error ? e.message : '预设目录读取失败' }
  }
  async function refresh(kind: 'status' | 'queue' | 'history') {
    if (state[`${kind}Loading`]) return
    state[`${kind}Loading`] = true
    const generation=readGeneration,controller=new AbortController();recordReads.add(controller)
    try {
      const { data } = await request<any>(`/api/modules/qq/${kind}`,{signal:controller.signal})
      if(generation!==readGeneration)return
      if (kind === 'status') state.status = data
      else {
        state[kind] = QQEntriesSchema.parse(data)
        state.recordsRevision++
      }
      state[`${kind}Error`] = ''
    }
    catch (e) { if(generation===readGeneration){denied(e);state[`${kind}Error`] = e instanceof Error ? e.message : '读取失败；已读内容尚未更新'} }
    finally { recordReads.delete(controller);state[`${kind}Loading`] = false }
  }
  async function detail(id: string,force=false) {
    const revision = state.recordsRevision
    if ((state.detailsLoading[id] && detailRevisions.get(id) === revision) || state.details[id]&&!force) return
    detailRevisions.set(id, revision)
    state.detailsLoading[id] = true; state.detailErrors[id] = ''
    const generation=readGeneration,controller=new AbortController();recordReads.add(controller)
    try {
      const { data } = await request<any>(`/api/modules/qq/entry?requestId=${encodeURIComponent(id)}`,{signal:controller.signal})
      if(generation!==readGeneration)return
      const checked = QQEntryDetailSchema.parse(data)
      if (checked.requestId !== id) throw new Error('记录详情不匹配，请重新读取。')
      if (revision === state.recordsRevision) {state.details[id] = checked;if(checked.sourceContext)sources.seedEntry(id,checked.sourceContext)}
    } catch (error) { if(generation===readGeneration)denied(error);if (revision === state.recordsRevision) state.detailErrors[id] = error instanceof Error ? error.message : '详情读取失败' }
    finally { recordReads.delete(controller);if (detailRevisions.get(id) === revision) { state.detailsLoading[id] = false; detailRevisions.delete(id) } }
  }
  async function save() {
    if (!state.ready || !dirty.value || state.saving || state.reading || state.uncertain) return
    for (const [target, preset] of Object.entries(state.config.bindings)) if (!preset) delete state.config.bindings[target]
    const checked = QQConfigSchema.safeParse(state.config)
    if (!checked.success) { state.error = checked.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('；'); return }
    state.saving = true; state.error = ''; state.message = ''
    const submitted = JSON.stringify(state.config)
    try {
      const result = await request<any>('/api/modules/qq/config', { method: 'PUT', body: JSON.stringify({ config: state.config, expectedBaseRevision: state.revision, requestId: requestId() }) })
      state.uncertain = true
      const readback = await request<any>('/api/modules/qq/config')
      if (result.data?.saved !== true || readback.data?.baseRevision !== result.data.baseRevision || JSON.stringify(readback.data.config) !== submitted) throw new Error('保存后回读不一致，请重新读取核对，禁止重复提交。')
      state.config = readback.data.config; state.original = JSON.stringify(state.config); state.revision = readback.data.baseRevision; state.apply = readback.data.apply; state.uncertain = false
      state.message = '已保存并回读确认'; await refresh('status')
    } catch (e) {
      denied(e)
      state.error = e instanceof Error ? e.message : '保存失败'
      state.uncertain = state.uncertain || !(e instanceof ManagerApiError) || ![400, 401, 403, 503].includes(e.status)
    } finally { state.saving = false }
  }
  function add(kind: 'groups' | 'users', text: string) {
    const ids = text.trim().split(/[\s,，;；]+/).filter(Boolean)
    if (!ids.length || ids.some(id => !/^[1-9][0-9]*$/.test(id))) { state.error = '请输入有效号码，用空格、逗号或换行分隔；不会自动修正号码。'; return false }
    state.config[kind] = [...new Set([...state.config[kind], ...ids])]; state.error = ''; return true
  }
  function remove(target: string) {
    const group = target.startsWith('group:')
    state.config[group ? 'groups' : 'users'] = state.config[group ? 'groups' : 'users'].filter((id: string) => `${group ? 'group:' : 'private:user:'}${id}` !== target)
    delete state.config.bindings[target]
    if (state.selected === target) state.selected = ''
  }
  async function summary(name: string) {
    const generation = ++summaryGeneration; state.summary = ''; state.summaryError = ''
    if (!name) return
    try {
      const { data } = await request<any>(`/api/modules/capabilities/resources/presets?name=${encodeURIComponent(name)}`)
      if (generation === summaryGeneration) state.summary = `预设：${data.name} · 模型配置：${data.value.brain || '未配置'} · 工具组：${data.value.senseGroup || '无'}`
    } catch (e) { denied(e);if (generation === summaryGeneration) state.summaryError = e instanceof Error ? e.message : '预设读取失败' }
  }
  let voiceGeneration = 0
  async function voices() {
    const generation = ++voiceGeneration, group = state.voiceGroup
    state.voices = []; state.voicesError = ''
    if (!group || !state.config?.groups.includes(group)) { state.voicesLoading = false; return }
    state.voicesLoading = true
    try {
      const { data } = await request<any>(`/api/modules/qq/voices?groupId=${encodeURIComponent(group)}`)
      if (!Array.isArray(data?.items) || !data.items.every((v: any) => typeof v.id === 'string' && typeof v.name === 'string')) throw new Error('声音目录响应不完整')
      if (generation === voiceGeneration && group === state.voiceGroup) state.voices = data.items
    } catch (e) { denied(e);if (generation === voiceGeneration && group === state.voiceGroup) state.voicesError = e instanceof Error ? e.message : '声音目录读取失败' }
    finally { if (generation === voiceGeneration) state.voicesLoading = false }
  }
  async function load() { await Promise.allSettled([read(), catalog(), refresh('status')]) }
  return { state, dirty, targets, read, catalog, refresh, detail, save, add, remove, summary, voices, load, sources,openRecords,dispose }
}
