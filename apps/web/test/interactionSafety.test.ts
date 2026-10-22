/* eslint-disable @typescript-eslint/no-explicit-any -- dynamic transpiled-module harness */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import * as vue from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as applyPresentation from '../src/features/agent/settings/config/applyPresentation'
// 媒体编排与角色编制模型是纯逻辑模块（无组件/浏览器依赖），作为真实实现注入被测模块。
import * as useComposerMediaModule from '../src/features/agent/composables/useComposerMedia'
import * as fileReferences from '../src/features/agent/composer/fileReferenceTarget'
import * as messageParts from '../src/domain/chat/messageParts'
import * as draftHistory from '../src/features/agent/composer/model/draftTextHistory'
import * as fileServices from '../src/application/files/public'
import * as protocol from '@chery/protocol'
import { createRoleConfigModel } from '../src/features/agent/runtime/roleConfigModel'
import * as uuidModule from '../src/utils/uuid'

// 真实 useComposerMedia 使用文件服务；只隔离上传和草稿保留 I/O。
// 用 vi.mock 拦截并转发到 composerFixture 注入的 deferred（mediaUpload.impl）。
const mediaUpload = vi.hoisted(() => ({ impl: null as null | (() => Promise<unknown>), adapt: null as null | ((assetId: string, chatId?: string) => Promise<unknown>) }))
vi.mock('@/application/files/public', () => ({
  fileApi: { contextKey: () => 'test-context', upload: () => mediaUpload.impl?.() ?? Promise.reject(new Error('upload not wired')), retainDraft: async () => {}, adapt: (assetId: string, chatId?: string) => mediaUpload.adapt?.(assetId, chatId) ?? Promise.reject(new Error('not configured')), drawings: async () => ({ tasks: [] }) },
  fileDraftLeases: { set() {}, drop() {} },
}))

function deferred<T = any>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// Execute the complete controller with real Vue refs/computed and isolated I/O.
function loadController(path: string, imports: Record<string, any>, immediate = false) {
  const watchers: Array<{ source: any; callback: any }> = []
  const hooks: Array<() => void> = []
  const module = { exports: {} as any }
  const source = readFileSync(resolve(process.cwd(), path), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const require = (name: string) => {
    if (name === 'vue')
      return {
        ...vue,
        provide() {},
        onMounted() {},
        onUnmounted: (fn: () => void) => hooks.push(fn),
        onBeforeUnmount: (fn: () => void) => hooks.push(fn),
        watch: (source: any, callback: any, options?: { immediate?: boolean }) => {
          watchers.push({ source, callback })
          if (immediate && options?.immediate) callback(source())
          return () => {}
        },
      }
    if (name in imports) return imports[name]
    if (name.endsWith('.vue') || name === '@element-plus/icons-vue') return {}
    throw new Error(`Missing test import: ${name}`)
  }
  new Function('require', 'module', 'exports', compiled)(require, module, module.exports)
  return { exports: module.exports, watchers, hooks }
}

const cleanupHooks: Array<() => void> = []
afterEach(() => {
  cleanupHooks.splice(0).reverse().forEach(fn => fn())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function settingsFixture(requiresConfirmation = false) {
  const pending = deferred()
  const confirm = vi.fn().mockRejectedValue('cancel')
  const api = {
    previewConfig: vi.fn().mockResolvedValue({
      previewToken: 'preview',
      destructiveTargets: requiresConfirmation ? ['roles/reviewer'] : [],
      impacts: [],
    }),
    saveConfig: vi.fn(() => pending.promise),
  }
  const agents = { settingsOpen: true, settingsSection: null }
  const configApply = { savedRevision: '', apply: vi.fn() }
  const module = loadController('apps/web/src/features/agent/settings/useSettingsDialogController.ts', {
    '@/application/public': {
      useAgentsStore: () => agents,
      useConfigApplyStore: () => configApply,
      useConnectionStore: () => ({ status: 'connected' }),
    },
    '@/application/backend/public': { agentApi: api },
    '@/utils/uuid': { uuid: () => 'test-request' },
    '@/styles/overlayLayers': { OVERLAY_Z_INDEX: { modal: 10100 } },
    './config/constants': {
      TABS: [],
      HINT_LINES: {},
      INDEX_COUNT: {},
      SETTINGS_ACTIVE_TAB_KEY: Symbol(),
    },
    './config/applyPresentation': applyPresentation,
    './config/revisionSync': {
      externalRevisionAction: () => 'ignore',
      isRevisionConflict: () => false,
    },
    './model/settingsValidation': {
      SETTINGS_INPUT_ERRORS: Symbol('settings-input-errors'),
      settingsDraftErrors: () => [],
    },
    'element-plus': { ElMessageBox: { confirm } },
  })
  const controller = module.exports.useSettingsDialogController({})
  controller.draft.value = { sense_groups: {}, global: { value: 'A' } }
  return { controller, pending, api, agents, confirm }
}

describe('settings save and close safety', () => {
  it('submits once after explicit confirmation without a second save click', async () => {
    const { controller: c, pending, api, confirm } = settingsFixture(true)
    const approval = deferred()
    confirm.mockReturnValue(approval.promise)
    const save = c.save()
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce())
    expect(api.saveConfig).not.toHaveBeenCalled()
    await c.save()
    expect(api.previewConfig).toHaveBeenCalledOnce()
    c.draft.value.global.value = 'new edit'
    approval.resolve('confirm')
    await vi.waitFor(() => expect(api.saveConfig).toHaveBeenCalledOnce())
    expect(api.saveConfig.mock.calls[0]![0]).toMatchObject({
      candidate: { global: { value: 'A' } },
      previewToken: 'preview',
      policy: 'wait',
    })
    pending.resolve({ baseRevision: 'r1', warnings: [] })
    await save
    expect(c.hasUnsavedChanges.value).toBe(true)
  })

  it('cancels without saving and requests confirmation again on retry', async () => {
    const { controller: c, pending, api, confirm } = settingsFixture(true)
    await c.save()
    expect(api.saveConfig).not.toHaveBeenCalled()
    expect(c.saving.value).toBe(false)
    expect(c.error.value).toBeNull()
    expect(c.hasUnsavedChanges.value).toBe(true)
    confirm.mockResolvedValue('confirm')
    pending.resolve({ baseRevision: 'r1', warnings: [] })
    await c.save()
    expect(confirm).toHaveBeenCalledTimes(2)
    expect(api.previewConfig).toHaveBeenCalledTimes(2)
    expect(api.saveConfig).toHaveBeenCalledOnce()
    expect(c.hasUnsavedChanges.value).toBe(false)
  })

  it('baselines the submitted snapshot and keeps edits made during save dirty', async () => {
    const { controller: c, pending, api } = settingsFixture()
    c.updateHooksHandlers({ before: [{ value: 'hook A' }] })
    const save = c.save()
    await vi.waitFor(() => expect(api.saveConfig).toHaveBeenCalledOnce())
    expect(api.saveConfig.mock.calls[0]![0].candidate.global.value).toBe('A')
    c.draft.value.global.value = 'B'
    c.updateHooksHandlers({ before: [{ value: 'hook B' }] })
    pending.resolve({ baseRevision: 'r1', warnings: [] })
    await save
    expect(c.hasUnsavedChanges.value).toBe(true)
    expect(c.hooksState.dirty).toBe(true)
    expect(c.savedHint.value).toContain('新修改仍未保存')
  })

  it('reactively clears dirty after a successful unchanged save', async () => {
    const { controller: c, pending } = settingsFixture()
    expect(c.hasUnsavedChanges.value).toBe(true)
    const save = c.save()
    pending.resolve({ baseRevision: 'r1', warnings: [] })
    await save
    expect(c.hasUnsavedChanges.value).toBe(false)
    c.draft.value.global.value = 'B'
    expect(c.hasUnsavedChanges.value).toBe(true)
  })

  it('preserves drafts on failure and cancellation and blocks close while saving', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { controller: c, pending, agents, confirm } = settingsFixture()
    await c.close()
    expect(confirm).toHaveBeenCalledOnce()
    expect(agents.settingsOpen).toBe(true)
    const save = c.save()
    expect(await c.confirmClose()).toBe(false)
    pending.reject(new Error('save failed'))
    await save
    expect(c.draft.value.global.value).toBe('A')
    expect(c.hasUnsavedChanges.value).toBe(true)
    confirm.mockResolvedValue('confirm')
    await c.close()
    expect(agents.settingsOpen).toBe(false)
  })
})

function composerFixture(connected = false) {
  vi.stubGlobal('window', { addEventListener() {}, removeEventListener() {}, getSelection: () => null })
  // node 测试环境无 URL.createObjectURL/revokeObjectURL（媒体预览用），补最小 stub。
  class URLWithObjectRefs extends URL {
    static createObjectURL(): string {
      return 'blob:test'
    }
    static revokeObjectURL(): void {}
  }
  vi.stubGlobal('URL', URLWithObjectRefs)
  const upload = deferred()
  mediaUpload.impl = () => upload.promise
  mediaUpload.adapt = null
  const submit = vi.fn().mockResolvedValue(undefined)
  const runtime = vi.fn().mockResolvedValue({ applied: [], deferredRunning: [] })
  const drawing = loadController('apps/web/src/features/agent/composer/useDrawingDraft.ts', {
    '@chery/protocol': protocol,
    '@/application/files/public': fileServices,
    '@/utils/uuid': uuidModule,
  })
  const listBrains = vi.fn(() => new Promise(() => {}))
  const module = loadController('apps/web/src/features/agent/composer/useAgentDialogOptions.ts', {
    '@/utils/uuid': uuidModule,
    '@/application/public': {
      useAgentsStore: () => ({
        activeDialogChatId: 'chat-a',
        petForChat: () => ({ preset: 'test' }),
        setSessionRuntime: runtime,
        historyList: [],
      }),
      useChatSessionsStore: () => ({ sessionsById: {}, openSession: vi.fn(), submitInput: submit }),
      useConfigApplyStore: () => ({ savedRevision: '' }),
    },
    '@/application/transport/public': {
      wsClient: { getStatus: () => connected ? 'connected' : 'disconnected', onStatus: () => () => {} },
    },
    '@/application/backend/public': {
      agentApi: { uploadMedia: () => upload.promise, listBrains },
    },
    '@/application/files/public': fileServices,
    './fileReferenceTarget': fileReferences,
    '@/domain/chat/messageParts': messageParts,
    './model/draftTextHistory': draftHistory,
    './useDrawingDraft': drawing.exports,
    '@/application/platform/public': { httpUrl: (path: string) => path },
    '@/domain/pets/presets': { CHERY_NYXUS_PRESET: 'nyxus' },
    '@/styles/overlayLayers': { ownerOverlayZIndex: () => 501 },
    '@/features/agent/composables/commands': {
      COMPACT_COMMAND: {},
      composeCommandPrompt: (text: string) => text,
    },
    // 媒体链路与角色编制模型为纯逻辑模块，直接使用真实实现（与产品行为一致）。
    '@/features/agent/composables/useComposerMedia': useComposerMediaModule,
    '@/features/agent/runtime/roleConfigModel': { createRoleConfigModel },
  }, connected)
  const chatId = vue.ref('chat-a')
  const c = module.exports.useAgentDialogOptions({ chatId })
  cleanupHooks.push(...module.hooks, ...drawing.hooks)
  c.roleSelections.value = { 主角色: { brain: 'brain', senseGroup: 'default' } }
  c.config.value = {
    llm: { brain: { brain: { capabilities: { input: { image: true } } } } },
    media: { images: { type: 'image', enabled: true, url: 'test' } },
  }
  c.text.value = 'message'
  return { c, upload, submit, runtime, chatId, module, listBrains, drawing }
}

describe('composer draft and attachment safety', () => {
  it('initializes the connected workbench without randomUUID and loads options once', () => {
    const cryptoApi = globalThis.crypto
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => cryptoApi.getRandomValues(bytes) })
    const { c, listBrains } = composerFixture(true)
    expect(c).toBeDefined()
    expect(listBrains).toHaveBeenCalledTimes(1)
  })
  const attachment = {
    assetId: 'image-a',
    assetVersionId: 'version-a',
    filename: 'image.png',
    status: 'ready',
    size: 12,
    kind: 'image',
    mimeType: 'image/png',
    previewUrl: 'blob:test',
  }

  it('requires a sense group only when the selected brain supports tools', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { c, submit } = composerFixture()
    c.roleSelections.value.主角色.senseGroup = ''
    expect(await c.handleSend(undefined, { keepOpen: true })).toBe(false)
    expect(submit).not.toHaveBeenCalled()
    expect(c.error.value).toContain('器官组')
    c.config.value.llm.brain.brain = { capabilities: { toolCall: false } }
    expect(await c.handleSend(undefined, { keepOpen: true })).toBe(true)
  })

  it('removes acknowledged attachments so the next message is text-only', async () => {
    const { c, submit } = composerFixture()
    c.mediaAttachments.value = [attachment]
    expect(await c.handleSend(undefined, { keepOpen: true })).toBe(true)
    expect(c.mediaAttachments.value).toEqual([])
    c.text.value = 'second'
    await c.handleSend(undefined, { keepOpen: true })
    expect(submit.mock.calls[0]![2].filter((part: any) => part.type === 'asset')).toHaveLength(1)
    expect(submit.mock.calls[1]![2]).toEqual([{ partId: 'part-0', type: 'text', text: 'second' }])
  })

  it('keeps text and attachments after a failed ACK', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { c, submit } = composerFixture()
    c.mediaAttachments.value = [attachment]
    submit.mockRejectedValueOnce(new Error('offline'))
    expect(await c.handleSend(undefined, { keepOpen: true })).toBe(false)
    expect(c.text.value).toBe('message')
    expect(c.mediaAttachments.value).toHaveLength(1)
  })

  it('blocks send during upload and discards results after reset', async () => {
    const { c, upload, submit } = composerFixture()
    const pending = c.onMediaSelected({
      raw: new Blob(['image-bytes'], { type: 'image/png' }),
    })
    // 共享上传编排先过 prepare 微任务才置 uploading，等待置位后断言发送被阻塞。
    await vi.waitFor(() => expect(c.uploading.value).toBe(true))
    expect(await c.handleSend()).toBe(false)
    expect(submit).not.toHaveBeenCalled()
    c.resetMedia()
    upload.resolve({ id: 'late', kind: 'image' })
    await pending
    expect(c.mediaAttachments.value).toEqual([])
    expect(c.uploading.value).toBe(false)
  })

  it('observes an uploading GIF without running send validation and updates fixed-version draft parts when ready', async () => {
    const { c, upload, submit, drawing } = composerFixture()
    c.config.value.files = { context: { defaultImageVariant: 'original' } }
    const file = new File(['gif-bytes'], 'image-1785288018370.gif', { type: 'image/gif' })
    const pending = c.onMediaSelected({ raw: file })
    await vi.waitFor(() => expect(c.uploading.value).toBe(true))
    const observe = drawing.watchers.at(-1)!.source
    expect(observe()).toBe('[]')
    expect(await c.handleSend()).toBe(false)
    expect(submit).not.toHaveBeenCalled()
    upload.resolve({ id: 'gif', versionId: 'gif-v1', originalName: file.name, kind: 'image', mimeType: file.type, sizeBytes: file.size })
    await pending
    expect(JSON.parse(observe())).toEqual([expect.objectContaining({ type: 'asset', assetId: 'gif', assetVersionId: 'gif-v1', usage: 'content', variant: 'original' })])
    c.mediaAttachments.value[0].compressed = { assetId: 'adapted', assetVersionId: 'adapted-v1', mimeType: 'image/webp' }
    c.mediaAttachments.value[0].useCompressed = true
    c.mediaAttachments.value[0].usage = 'reference-only'
    expect(JSON.parse(observe())).toEqual([expect.objectContaining({ assetId: 'adapted', assetVersionId: 'adapted-v1', usage: 'reference-only', variant: 'adapted' })])
    expect(c.mediaAttachments.value[0].referenceId).toBeTruthy()
    expect(submit).not.toHaveBeenCalled()
  })

  it('keeps failed attachments visible without throwing in draft observation and still blocks sending them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { c, upload, submit, drawing } = composerFixture()
    const pending = c.onMediaSelected({ raw: new File(['text'], 'draft.txt', { type: 'text/plain' }) })
    await vi.waitFor(() => expect(c.uploading.value).toBe(true))
    upload.reject(new Error('上传失败')); await pending
    expect(drawing.watchers.at(-1)!.source()).toBe('[]')
    expect(c.mediaAttachments.value[0].status).toBe('failed')
    expect(await c.handleSend()).toBe(false)
    expect(submit).not.toHaveBeenCalled()
    expect(c.mediaAttachments.value).toHaveLength(1)
    expect(c.text.value).toContain('message')
  })

  it('restores a conversation draft after switching away and back', async () => {
    const { c, chatId, module } = composerFixture()
    const watcher = module.watchers.find((watcher) => typeof watcher.source === 'function' && Array.isArray(watcher.source()) && watcher.source()[0] === 'chat-a')!
    watcher.callback(['chat-a', 'test-context'])
    c.text.value = 'draft A'
    c.mediaAttachments.value = [attachment]
    chatId.value = 'chat-b'
    watcher.callback(['chat-b', 'test-context'])
    c.text.value = 'draft B'
    chatId.value = 'chat-a'
    watcher.callback(['chat-a', 'test-context'])
    expect(c.text.value).toBe('draft A')
    expect(c.mediaAttachments.value[0].assetId).toBe('image-a')
  })
})
