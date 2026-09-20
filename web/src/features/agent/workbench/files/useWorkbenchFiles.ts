import { computed, reactive, ref, watch } from 'vue'
import {
  agentApi,
  type WorkspaceFileContent,
  type WorkspaceFileEntry,
} from '@/application/backend/public'
import hljs from 'highlight.js'
import { fileType } from './fileType'

type Directory = {
  entries: WorkspaceFileEntry[]
  loading: boolean
  showLoading: boolean
  error: string
  nextOffset?: number
}
type FileTab = {
  path: string
  content?: WorkspaceFileContent
  loading: boolean
  showLoading: boolean
  error: string
}
type OpenedFile = Pick<WorkspaceFileEntry, 'path' | 'name' | 'kind' | 'extension'>
const MAX_RESIDENT_FILES = 5
export function useWorkbenchFiles(chatId: () => string) {
  const directories = reactive(new Map<string, Directory>())
  const expanded = reactive(new Set<string>(['']))
  const tabs = ref<FileTab[]>([])
  const openedFiles = ref<OpenedFile[]>([])
  const activePath = ref('')
  const recentPaths = ref<string[]>([])
  const workspace = ref('')
  let generation = 0
  function touchResident(path: string): void {
    recentPaths.value = [path, ...recentPaths.value.filter((item) => item !== path)]
    while (recentPaths.value.length > MAX_RESIDENT_FILES) {
      const candidate = recentPaths.value.find((item) => item !== activePath.value)
      if (!candidate) break
      recentPaths.value = recentPaths.value.filter((item) => item !== candidate)
      const tab = tabs.value.find((item) => item.path === candidate)
      if (tab) tab.content = undefined
    }
  }
  async function load(path = '', more = false): Promise<void> {
    const targetChat = chatId(),
      version = generation
    if (!targetChat) return
    if (!directories.has(path))
      directories.set(path, { entries: [], loading: false, showLoading: false, error: '' })
    const directory = directories.get(path)!
    if (directory.loading) return
    directory.loading = true
    directory.showLoading = false
    directory.error = ''
    const delayedLoading = setTimeout(() => {
      directory.showLoading = true
    }, 1500)
    try {
      const result = await agentApi.listWorkspaceFiles(
        targetChat,
        path,
        more ? directory.nextOffset : undefined,
      )
      if (version !== generation) return
      directory.entries = more ? [...directory.entries, ...result.entries] : result.entries
      directory.nextOffset = result.nextOffset
      workspace.value = result.workspace
    } catch (error) {
      if (version === generation)
        directory.error = error instanceof Error ? error.message : '目录读取失败'
    } finally {
      clearTimeout(delayedLoading)
      directory.loading = false
      directory.showLoading = false
    }
  }
  const rows = computed(() => {
    const result: Array<{ entry: WorkspaceFileEntry; depth: number }> = []
    function visit(path: string, depth: number): void {
      for (const entry of directories.get(path)?.entries ?? []) {
        result.push({ entry, depth })
        if (entry.kind === 'directory' && expanded.has(entry.path)) visit(entry.path, depth + 1)
      }
    }
    visit('', 0)
    return result
  })
  async function refresh(): Promise<void> {
    generation++
    directories.clear()
    await load()
    await Promise.all([...expanded].filter(Boolean).map((path) => load(path)))
  }
  async function open(entry: WorkspaceFileEntry): Promise<void> {
    if (entry.kind === 'directory') {
      if (expanded.has(entry.path)) expanded.delete(entry.path)
      else {
        expanded.add(entry.path)
        if (!directories.has(entry.path)) await load(entry.path)
      }
      return
    }
    const segments = entry.path.split('/')
    let parent = ''
    for (const segment of segments.slice(0, -1)) {
      parent = parent ? `${parent}/${segment}` : segment
      expanded.add(parent)
      if (!directories.has(parent)) await load(parent)
    }
    activePath.value = entry.path
    if (!openedFiles.value.some((item) => item.path === entry.path)) openedFiles.value.push(entry)
    touchResident(entry.path)
    const existing = tabs.value.find((tab) => tab.path === entry.path)
    if (existing && existing.content && !existing.error) return
    if (existing) tabs.value.splice(tabs.value.indexOf(existing), 1)
    const tab = reactive<FileTab>({ path: entry.path, loading: true, showLoading: false, error: '' })
    tabs.value.push(tab)
    const delayedLoading = setTimeout(() => {
      tab.showLoading = true
    }, 2000)
    try {
      tab.content = await agentApi.readWorkspaceFile(chatId(), entry.path)
    } catch (error) {
      tab.error = error instanceof Error ? error.message : '文件读取失败'
    } finally {
      clearTimeout(delayedLoading)
      tab.loading = false
      const resident = new Set(recentPaths.value)
      tabs.value.forEach((item) => { if (!resident.has(item.path) && item.path !== activePath.value) item.content = undefined })
    }
  }
  async function activate(path: string): Promise<void> {
    const tab = tabs.value.find((item) => item.path === path)
    if (!tab) return
    activePath.value = path
    touchResident(path)
    if (!tab.content && !tab.loading) await open({ path, name: path.split('/').pop() ?? path, kind: 'file', extension: fileType(path).language })
  }
  function close(path: string): void {
    const index = tabs.value.findIndex((tab) => tab.path === path)
    if (index === -1) return
    tabs.value.splice(index, 1)
    openedFiles.value = openedFiles.value.filter((item) => item.path !== path)
    recentPaths.value = recentPaths.value.filter((item) => item !== path)
    if (activePath.value === path) {
      const next = tabs.value[Math.min(index, tabs.value.length - 1)]?.path ?? ''
      activePath.value = next
      if (next) void activate(next)
    }
  }
  function closeSide(side: 'left' | 'right'): void {
    const index = tabs.value.findIndex((tab) => tab.path === activePath.value)
    if (index < 0) return
    const paths = side === 'left' ? tabs.value.slice(0, index).map((tab) => tab.path) : tabs.value.slice(index + 1).map((tab) => tab.path)
    paths.forEach(close)
  }
  function closeOthers(): void { tabs.value.filter((tab) => tab.path !== activePath.value).map((tab) => tab.path).forEach(close) }
  function closeAll(): void {
    tabs.value = []
    openedFiles.value = []
    activePath.value = ''
    recentPaths.value = []
  }
  async function refreshFile(path = activePath.value): Promise<void> {
    const tab = tabs.value.find((item) => item.path === path)
    if (!tab) return
    tab.loading = true; tab.showLoading = false; tab.error = ''
    const timer = setTimeout(() => { tab.showLoading = true }, 2000)
    try { tab.content = await agentApi.readWorkspaceFile(chatId(), path) }
    catch (error) { tab.error = error instanceof Error ? error.message : '文件读取失败' }
    finally { clearTimeout(timer); tab.loading = false; tab.showLoading = false }
  }
  const active = computed(() => tabs.value.find((tab) => tab.path === activePath.value))
  const residentTabs = computed(() => tabs.value.filter((tab) => recentPaths.value.includes(tab.path) || tab.path === activePath.value))
  const highlighted = computed(() => {
    const content = active.value?.content
    if (content?.kind !== 'text') return ''
    const language = fileType(content.path).language
    const value = content.content ?? ''
    if (value.length <= 100000 && hljs.getLanguage(language))
      return hljs.highlight(value, { language, ignoreIllegals: true }).value
    return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  })
  watch(
    chatId,
    () => {
      generation++
      workspace.value = ''
      directories.clear()
      expanded.clear()
      expanded.add('')
      tabs.value = []
      openedFiles.value = []
      activePath.value = ''
      recentPaths.value = []
      void load()
    },
    { immediate: true },
  )
  return {
    directories,
    expanded,
    tabs,
    activePath,
    active,
    activate,
    residentTabs,
    rows,
    workspace,
    highlighted,
    load,
    refresh,
    open,
    close,
    closeSide,
    closeOthers,
    closeAll,
    refreshFile,
    recentPaths,
    openedFiles,
  }
}
