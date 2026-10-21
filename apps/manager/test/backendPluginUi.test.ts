import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { BACKEND_PLUGIN_ID, BACKEND_PLUGIN_TITLE, useBackendPlugin, type BackendPluginStatus } from '../ui/useBackendPlugin'
import { usePlugins } from '../ui/usePlugins'
import type { managerRequest } from '../../../packages/manager-ui/src/api'

const source = (name: string) => readFileSync(resolve(import.meta.dirname, '../ui', name), 'utf8')

function sampleStatus(overrides: Partial<BackendPluginStatus> = {}): BackendPluginStatus {
  return {
    state: 'inactive',
    running: false,
    pid: null,
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    nextRetryInMs: null,
    lastError: null,
    stableSince: null,
    uptimeSeconds: 0,
    autoStart: true,
    managedBy: 'manager',
    listener: { host: '127.0.0.1', port: 8182, ready: false },
    resources: {
      system: { memoryUsedRatio: 0.42, load1: 0.5, uptimeSeconds: 3600 },
      process: { pid: null, uptimeSeconds: 0, cpuPercent: null, memoryBytes: null },
    },
    versionCompatibility: { contractVersion: 1, compatible: true },
    logs: [],
    ...overrides,
  }
}

describe('WP2 preinstalled Backend management plugin UI & peer offline fallback', () => {
  it('loads status, toggles autoStart, starts Backend, and cancels retry via useBackendPlugin', async () => {
    let current = sampleStatus()
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/backend-plugin/status') return { data: current }
      if (path === '/api/backend-plugin/config' && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { autoStart: boolean }
        current = { ...current, autoStart: body.autoStart }
        return { data: { autoStart: current.autoStart } }
      }
      if (path === '/api/backend-plugin/start' && init?.method === 'POST') {
        current = sampleStatus({
          state: 'running',
          running: true,
          pid: 4242,
          uptimeSeconds: 18,
          listener: { host: '127.0.0.1', port: 8182, ready: true },
          resources: {
            system: { memoryUsedRatio: 0.45, load1: 0.6, uptimeSeconds: 3618 },
            process: { pid: 4242, uptimeSeconds: 18, cpuPercent: 3.2, memoryBytes: 64 * 1024 * 1024 },
          },
          logs: [{ timestamp: '2026-10-20T01:00:00.000Z', stream: 'stdout', line: 'backend ready' }],
        })
        return { data: current }
      }
      if (path === '/api/backend-plugin/cancel-retry' && init?.method === 'POST') {
        current = {
          ...current,
          state: 'failed',
          nextRetryAt: null,
          nextRetryInMs: null,
          lastError: '后端非预期退出（退出码 1）（已手动取消自动重试）',
        }
        return { data: current }
      }
      throw new Error(`unexpected request: ${path}`)
    })

    const controller = useBackendPlugin(request as unknown as typeof managerRequest)
    await controller.read()
    expect(controller.state.status?.state).toBe('inactive')
    expect(controller.state.status?.autoStart).toBe(true)

    await controller.saveAutoStart(false)
    expect(controller.state.status?.autoStart).toBe(false)
    expect(controller.state.message).toContain('已关闭“随插件启动 Backend”')

    await controller.start()
    expect(controller.state.status?.state).toBe('running')
    expect(controller.state.status?.pid).toBe(4242)
    expect(controller.state.status?.logs).toHaveLength(1)

    current = sampleStatus({
      state: 'retrying',
      retryCount: 2,
      maxRetries: 3,
      nextRetryAt: '2026-10-20T01:00:15.000Z',
      nextRetryInMs: 15_000,
      lastError: '后端非预期退出（退出码 1）',
    })
    await controller.read()
    expect(controller.state.status?.state).toBe('retrying')
    expect(controller.state.status?.retryCount).toBe(2)

    await controller.cancelRetry()
    expect(controller.state.status?.state).toBe('failed')
    expect(controller.state.status?.nextRetryAt).toBeNull()
    expect(controller.state.status?.lastError).toContain('已手动取消自动重试')
  })

  it('keeps peer plugins visible with backendUnavailable reason when Backend is offline and skips /api/modules failure', async () => {
    const request = vi.fn(async (path: string) => {
      if (path === '/api/plugins') {
        return {
          data: {
            contractVersion: 2,
            hostApiVersion: 2,
            registryRevision: 5,
            backendUnavailable: true,
            reason: '依赖 Backend 运行，当前不可用',
            plugins: [
              {
                id: 'qq',
                apiVersion: 2,
                installed: true,
                enabled: true,
                savedVersion: '1.2.3',
                activeVersion: null,
                state: 'unknown',
                requiresRestart: false,
                savedRevision: 5,
                appliedRevision: null,
                apply: 'pending',
                reason: '依赖 Backend 运行，当前不可用',
                grantedCapabilities: ['ingress', 'manager.ui'],
                dependencies: [],
                backendUnavailable: true,
              },
            ],
          },
        }
      }
      throw new Error('Backend offline: /api/modules must not break plugin list')
    })

    const plugins = usePlugins(request as unknown as typeof managerRequest)
    await plugins.read()
    expect(plugins.state.error).toBe('')
    expect(plugins.state.list?.backendUnavailable).toBe(true)
    expect(plugins.state.list?.plugins).toHaveLength(1)
    expect(plugins.state.list?.plugins[0]).toMatchObject({
      id: 'qq',
      backendUnavailable: true,
      reason: '依赖 Backend 运行，当前不可用',
    })
  })

  it('exposes stop, cancel, force and plugin disable without offering uninstall', () => {
    const backendPanel = source('BackendPluginPanel.vue')
    const pluginsPanel = source('PluginsPanel.vue')

    expect(BACKEND_PLUGIN_ID).toBe('cherynyxus-backend-manager')
    expect(BACKEND_PLUGIN_TITLE).toBe('Backend 管理插件')
    expect(backendPanel).toContain('默认预装 · 内置不可卸载')
    expect(backendPanel).toContain('随插件启动 Backend')
    expect(backendPanel).toContain('启动 Backend')
    expect(backendPanel).toContain('取消重试')
    expect(backendPanel).toContain('Backend 业务登录设置（AI Web）')
    expect(backendPanel).toContain('当前版本不支持管理该项')
    expect(backendPanel).toContain('停止 Backend')
    expect(backendPanel).toContain('取消关闭')
    expect(backendPanel).toContain('中断任务并关闭')
    expect(backendPanel).toContain('启用 Backend 管理插件')
    expect(backendPanel).toContain('插件停用：')
    expect(backendPanel).not.toContain('/api/backend-plugin/stop')
    expect(backendPanel).not.toContain('卸载插件')

    expect(pluginsPanel).toContain('<BackendPluginPanel')
    expect(pluginsPanel).toContain('依赖 Backend 运行，当前不可用')
    expect(pluginsPanel).toContain('plugin.backendUnavailable || backendOffline')
  })
})
