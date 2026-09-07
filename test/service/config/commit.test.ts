import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { readRawConfig } from '@/utils/config.js'
import type * as Commit from '@/service/config/commit.js'
import { configSaveSchema } from '@/service/message/schemas.js'
import yaml from 'js-yaml'

let api: typeof Commit
let original: Buffer
let hooksOriginal: Buffer | undefined
let filename: string
let hooksFile: string
beforeEach(async () => {
  filename = path.join(process.env.CHERY_DIR!, '.chery/config.yaml')
  hooksFile = path.join(process.env.CHERY_DIR!, '.chery/hooks/hooks.json')
  original = fs.readFileSync(filename)
  hooksOriginal = fs.existsSync(hooksFile) ? fs.readFileSync(hooksFile) : undefined
  vi.resetModules()
  api = await import('@/service/config/commit.js')
  api.getConfigApplyCoordinator()
})
afterEach(async () => {
  vi.restoreAllMocks()
  await api.getConfigApplyCoordinator().retry()
  await (await import('@/core/mcp/loader.js')).closeMcpClients()
  fs.writeFileSync(filename, original)
  if (hooksOriginal) fs.writeFileSync(hooksFile, hooksOriginal)
  else if (fs.existsSync(hooksFile)) fs.unlinkSync(hooksFile)
})
function input() {
  return {
    candidate: readRawConfig(),
    expectedBaseRevision: api.getSavedBaseRevision(),
    requestId: 'test-request',
  }
}
describe('serialized config commit', () => {
  it('routes saved MCP changes and explicit reload through the same coordinator with truthful failures', async () => {
    const mcp = await import('@/core/mcp/client.js')
    const loader = await import('@/core/mcp/loader.js')
    const config = await import('@/utils/config.js')
    const close = vi.fn().mockResolvedValue(undefined)
    const connect = vi.spyOn(mcp, 'connectMcpServer').mockResolvedValue({
      name: 'reload-test',
      close,
      client: {
        getServerCapabilities: () => ({ tools: {} }),
        listTools: async () => ({ tools: [] }),
      } as never,
    })
    const request = input()
    request.candidate.mcp_servers = {
      'reload-test': { transport: 'streamable-http', url: 'http://old' },
    }
    expect(api.commitConfigCandidate(request)).toMatchObject({ ok: true, status: 'pending' })
    await api.getConfigApplyCoordinator().retry()
    expect(loader.getMcpServer('reload-test').applyStatus).toBe('applied')
    await api.reloadMcpConfiguration()
    expect(connect).toHaveBeenCalledOnce()
    const disk = config.readRawConfig()
    disk.mcp_servers!['reload-test']!.url = 'http://new'
    expect(config.saveRawConfig(disk).ok).toBe(true)
    connect.mockRejectedValueOnce(new Error('private endpoint'))
    const failed = await api.reloadMcpConfiguration('reload-test')
    expect(failed.apply.status).toBe('failed')
    expect(loader.getMcpServer('reload-test')).toMatchObject({
      status: 'connected',
      applyStatus: 'failed',
    })
    expect(config.getAppliedRawConfig().mcp_servers!['reload-test']!.url).toBe('http://old')
    expect(close).not.toHaveBeenCalled()
    const success = await api.reloadMcpConfiguration('reload-test')
    expect(success.apply.status).toBe('applied')
    expect(config.getAppliedRawConfig().mcp_servers!['reload-test']!.url).toBe('http://new')
    expect(close).toHaveBeenCalledOnce()
  })
  it('requires a bound preview for role deletion and accepts only the waiting policy', () => {
    const create = input()
    create.candidate.sense_groups = { ...create.candidate.sense_groups, 'preview-tools': [] }
    create.candidate.roles = {
      ...create.candidate.roles,
      'preview-role': {
        id: 'role-preview123',
        brain: Object.keys(create.candidate.llm.brain)[0]!,
        senseGroup: 'preview-tools',
      },
    }
    expect(api.commitConfigCandidate(create).ok).toBe(true)
    const remove = { ...input(), requestId: 'delete-role' }
    delete remove.candidate.roles!['preview-role']
    expect(api.commitConfigCandidate(remove)).toMatchObject({ ok: false, kind: 'preview' })
    const preview = api.previewConfigCandidate(remove)
    if (!('previewToken' in preview)) throw Error('preview failed')
    expect(preview.destructiveTargets).toContain('roles/role-preview123')
    expect(
      api.commitConfigCandidate({ ...remove, policy: 'wait', previewToken: preview.previewToken })
        .ok,
    ).toBe(true)
    expect(
      configSaveSchema.safeParse({ protocolVersion: 2, ...remove, policy: 'cancel' }).success,
    ).toBe(false)
  })
  it('rejects expired preview tokens before writing', () => {
    const request = input()
    request.candidate.global.textEditor = 'preview-editor'
    const preview = api.previewConfigCandidate(request)
    if (!('previewToken' in preview)) throw Error('preview failed')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300_001)
    expect(
      api.commitConfigCandidate({ ...request, previewToken: preview.previewToken }),
    ).toMatchObject({ ok: false, kind: 'preview' })
    expect(fs.readFileSync(filename)).toEqual(original)
  })
  it('watcher acknowledges structured resource saves repeatedly without restart', async () => {
    const restart = await import('@/service/restartCoordinator.js')
    const spy = vi.spyOn(restart, 'requestRestartWhenIdle')
    const { startConfigRevisionWatcher } = await import('@/service/config/watcher.js')
    const watcher = startConfigRevisionWatcher()
    try {
      const request = input()
      request.candidate.sense_groups = { ...request.candidate.sense_groups, 'new-tools': [] }
      expect(api.commitConfigCandidate(request).ok).toBe(true)
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(spy).not.toHaveBeenCalled()
    } finally {
      watcher.close()
    }
  })
  it('applies a manual edit that supersedes an unobserved structured save', async () => {
    const { startConfigRevisionWatcher } = await import('@/service/config/watcher.js')
    const watcher = startConfigRevisionWatcher()
    try {
      const request = input()
      request.candidate.global.textEditor = 'structured-editor'
      expect(api.commitConfigCandidate(request).ok).toBe(true)
      const disk = yaml.load(fs.readFileSync(filename, 'utf8')) as {
        global: { textEditor?: string }
      }
      disk.global.textEditor = 'manual-editor'
      fs.writeFileSync(filename, yaml.dump(disk))
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      await api.getConfigApplyCoordinator().retry()
      expect((await import('@/utils/config.js')).getAppliedRawConfig().global.textEditor).toBe(
        'manual-editor',
      )
    } finally {
      watcher.close()
    }
  })
  it('classifies a manual server-only edit as restart pending without requesting restart', async () => {
    const restart = await import('@/service/restartCoordinator.js')
    const spy = vi.spyOn(restart, 'requestRestartWhenIdle')
    const { startConfigRevisionWatcher } = await import('@/service/config/watcher.js')
    const watcher = startConfigRevisionWatcher()
    try {
      const disk = yaml.load(fs.readFileSync(filename, 'utf8')) as {
        server?: { port?: number; [key: string]: unknown }
      }
      disk.server = { ...(disk.server ?? {}), port: Number(disk.server?.port ?? 8182) + 1 }
      fs.writeFileSync(filename, yaml.dump(disk))
      watcher.validateNow()
      await new Promise((resolve) => setTimeout(resolve, 650))
      expect(api.getConfigApplyCoordinator().getState()).toMatchObject({
        status: 'pending',
        restart: { required: true, status: 'pending' },
      })
      expect(spy).not.toHaveBeenCalled()
    } finally {
      watcher.close()
    }
  })
  it('does not write unchanged config or request restart', () => {
    const spy = vi.spyOn(fs, 'writeFileSync')
    const result = api.commitConfigCandidate(input())
    expect(result).toMatchObject({
      ok: true,
      status: 'applied',
      restart: { required: false, status: 'none' },
    })
    expect(spy.mock.calls.filter(([p]) => String(p) === filename)).toHaveLength(0)
    expect(fs.readFileSync(filename)).toEqual(original)
  })
  it('accepts template Hooks comments without rewriting the Hooks file', () => {
    const templateHooks = `${JSON.stringify(
      {
        _comment: 'Hooks help',
        _events: { SessionStart: 'runs before the first turn' },
        SessionStart: [{ _comment: 'test handler', command: "echo '{}'", timeout: 10 }],
      },
      null,
      2,
    )}\n`
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true })
    fs.writeFileSync(hooksFile, templateHooks)

    const request = input()
    request.candidate.global.textEditor = 'comment-compatible-editor'
    expect(api.commitConfigCandidate(request)).toMatchObject({ ok: true, status: 'pending' })
    expect(api.readConfigImage().hooks).toEqual({
      SessionStart: [{ command: "echo '{}'", timeout: 10 }],
    })
    expect(fs.readFileSync(hooksFile, 'utf8')).toBe(templateHooks)
  })
  it('rejects invalid config and Hooks before either file is written', () => {
    const request = input()
    request.candidate.global.textEditor = 'never saved'
    const result = api.commitConfigCandidate({
      ...request,
      hooks: { SessionStart: [{ command: '' }] },
    })
    expect(result).toMatchObject({ ok: false, kind: 'validation' })
    expect(fs.readFileSync(filename)).toEqual(original)
    request.candidate.global.supervision = 'bad' as never
    expect(api.commitConfigCandidate(request)).toMatchObject({ ok: false, kind: 'validation' })
    expect(fs.readFileSync(filename)).toEqual(original)
  })
  it('returns pending synchronously, then publishes the applied state', async () => {
    const events: unknown[] = []
    api.getConfigApplyCoordinator().subscribe((s) => events.push(s))
    const request = input()
    request.candidate.global.textEditor = 'new-editor'
    const result = api.commitConfigCandidate(request)
    expect(result).toMatchObject({ ok: true, status: 'pending' })
    expect(readRawConfig().global.textEditor).toBe('new-editor')
    await api.getConfigApplyCoordinator().retry()
    const state = api.getConfigApplyCoordinator().getState()
    expect(state).toMatchObject({
      savedRevision: result.ok ? result.savedRevision : undefined,
      status: 'applied',
      impacts: [
        expect.objectContaining({ resource: '["global","textEditor"]', status: 'applied' }),
      ],
    })
    expect(events.at(-1)).toEqual(state)
    expect(api.isStructuredConfigImageHandled()).toBe(true)
  })
  it('conflicts on a second writer but replays the identical request without writing', () => {
    const a = input(),
      b = input()
    a.candidate.global.textEditor = 'a'
    b.candidate.global.textEditor = 'b'
    b.requestId = 'other-request'
    const result = api.commitConfigCandidate(a)
    expect(result.ok).toBe(true)
    const spy = vi.spyOn(fs, 'writeFileSync')
    expect(api.commitConfigCandidate(a)).toEqual(result)
    expect(spy).not.toHaveBeenCalled()
    expect(api.commitConfigCandidate(b)).toMatchObject({ ok: false, kind: 'stale' })
    expect(api.commitConfigCandidate({ ...b, requestId: a.requestId })).toMatchObject({
      ok: false,
      kind: 'idempotency',
    })
  })
  it('writes config and hooks together without invalidating old hook runtime', async () => {
    const { loadHookRegistry } = await import('@/agent/hooks/registry.js')
    const old = loadHookRegistry()
    const request = input()
    request.candidate.global.textEditor = 'new-editor'
    expect(
      api.commitConfigCandidate({
        ...request,
        hooks: { SessionStart: [{ command: 'echo isolated' }] },
      }),
    ).toMatchObject({ ok: true, status: 'pending' })
    expect(JSON.parse(fs.readFileSync(hooksFile, 'utf8'))).toEqual({
      SessionStart: [{ command: 'echo isolated' }],
    })
    expect(loadHookRegistry()).toBe(old)
    expect(api.isStructuredConfigImageHandled()).toBe(true)
  })
  it('restores config if writing the Hooks file fails', () => {
    const write = fs.writeFileSync
    vi.spyOn(fs, 'writeFileSync').mockImplementation(
      (...args: Parameters<typeof fs.writeFileSync>) => {
        if (String(args[0]).startsWith(hooksFile)) throw Error('injected write failure')
        return write(...args)
      },
    )
    const request = input()
    request.candidate.global.textEditor = 'new-editor'
    const result = api.commitConfigCandidate({
      ...request,
      hooks: { SessionStart: [{ command: 'echo isolated' }] },
    })
    expect(result).toMatchObject({ ok: false })
    expect(fs.readFileSync(filename)).toEqual(original)
    expect(result.ok === false && ['save', 'partial-save'].includes(result.kind)).toBe(true)
  })
  it('binds previews to revision and candidate without writing during preview', () => {
    const request = input()
    request.candidate.global.textEditor = 'preview-editor'
    const preview = api.previewConfigCandidate(request)
    expect(preview).toHaveProperty('previewToken')
    if ('previewToken' in preview)
      expect(preview.impacts.some((i) => i.resource.startsWith('["assets"'))).toBe(false)
    expect(fs.readFileSync(filename)).toEqual(original)
    if (!('previewToken' in preview)) throw Error('preview failed')
    request.candidate.global.textEditor = 'changed-again'
    expect(
      api.commitConfigCandidate({ ...request, previewToken: preview.previewToken }),
    ).toMatchObject({ ok: false, kind: 'preview' })
  })
  it('includes Hooks-only changes in the optimistic revision', () => {
    const before = api.getSavedBaseRevision()
    fs.mkdirSync(path.dirname(hooksFile), { recursive: true })
    fs.writeFileSync(hooksFile, JSON.stringify({ Stop: [{ command: 'echo changed' }] }))
    expect(api.getSavedBaseRevision()).not.toBe(before)
    expect(
      api.commitConfigCandidate({ candidate: readRawConfig(), expectedBaseRevision: before }),
    ).toMatchObject({ ok: false, kind: 'stale' })
  })
  it('rejects old write protocol and retains nested unknown fields for conservative classification', () => {
    const candidate = readRawConfig()
    expect(configSaveSchema.safeParse(candidate).success).toBe(false)
    Object.assign(candidate.global, { futureOption: true })
    const parsed = configSaveSchema.safeParse({ protocolVersion: 2, ...input(), candidate })
    expect(parsed.success).toBe(true)
    if (parsed.success) expect(parsed.data.candidate.global.futureOption).toBe(true)
  })
})
