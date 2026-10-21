import { reactive } from 'vue'
import { managerRequest } from '../../../packages/manager-ui/src/api'
import type { BackendStopSnapshot } from '@chery/protocol'

export interface BackendLogEntry {
  timestamp: string
  stream: 'stdout' | 'stderr'
  line: string
}

export interface BackendPluginStatus {
  state: 'inactive' | 'starting' | 'running' | 'retrying' | 'failed'
  running: boolean
  pid: number | null
  retryCount: number
  maxRetries: number
  nextRetryAt: string | null
  nextRetryInMs: number | null
  lastError: string | null
  stableSince: string | null
  uptimeSeconds: number | null
  autoStart: boolean
  managedBy: 'manager' | 'external'
  listener: { host: string; port: number; ready: boolean }
  resources: {
    system: { memoryUsedRatio: number; load1?: number; uptimeSeconds: number }
    process: { pid: number | null; uptimeSeconds: number | null; cpuPercent: number | null; memoryBytes: number | null }
  }
  versionCompatibility: { contractVersion: number; compatible: boolean }
  logs: BackendLogEntry[]
  lifecycle?: BackendStopSnapshot | null
  intent?: { desiredState: 'running' | 'stopped'; pluginEnabled: boolean }
  pluginDisable?: { operationId: string | null; status: 'waiting' | 'saved' | 'failed'; error?: string } | null
}

export const BACKEND_PLUGIN_ID = 'cherynyxus-backend-manager'
export const BACKEND_PLUGIN_TITLE = 'Backend 管理插件'

export const backendStateLabels: Record<BackendPluginStatus['state'], string> = {
  inactive: '未启动',
  starting: '启动中',
  running: '运行中',
  retrying: '异常重试等待中',
  failed: '异常停止',
}

export function useBackendPlugin(request = managerRequest) {
  let mutation = 0
  const state = reactive({
    status: null as BackendPluginStatus | null,
    reading: false,
    writing: false,
    error: '',
    message: '',
  })

  async function read(quiet = false) {
    if (state.reading) return
    const generation = mutation
    state.reading = true
    if (!quiet) state.error = ''
    try {
      const result = await request<{ data: BackendPluginStatus }>('/api/backend-plugin/status')
      if (generation === mutation) state.status = result.data
    } catch (error) {
      if (generation === mutation) state.error = error instanceof Error ? error.message : 'Backend 管理插件状态读取失败'
    } finally {
      state.reading = false
    }
  }

  async function lifecycleAction(path: string, body: Record<string, unknown>, message: string, method = 'POST') {
    if (state.writing) return
    mutation++
    state.writing = true
    state.error = ''
    state.message = ''
    try {
      await request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      state.message = message
      const result = await request<{ data: BackendPluginStatus }>('/api/backend-plugin/status')
      state.status = result.data
    } catch (error) {
      state.error = error instanceof Error ? error.message : '操作未获确认，请刷新状态'
    } finally { state.writing = false }
  }

  const stop = () => lifecycleAction('/api/backend/stop', {}, '已请求关闭；以服务实际退出状态为准。')
  const setEnabled = (enabled: boolean) => lifecycleAction('/api/backend-plugin/enabled', { enabled },
    enabled ? '管理插件已启用，服务不会因此自动启动。' : '已请求先停止 Backend，再单独保存插件停用状态。', 'PUT')
  function resolveStop(action: 'cancel' | 'force') {
    const lifecycle = state.status?.lifecycle
    if (!lifecycle?.operationId) return
    return lifecycleAction(`/api/backend/stop/${action}`, { backendInstanceId: lifecycle.backendInstanceId, operationId: lifecycle.operationId },
      action === 'cancel' ? '取消关闭已获确认。' : '已请求中断任务并关闭；不会延长已有退出期限。')
  }

  async function start() {
    if (state.writing) return
    state.writing = true
    state.error = ''
    state.message = ''
    try {
      const result = await request<{ data: BackendPluginStatus }>('/api/backend-plugin/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      state.status = result.data
      state.message = '已发起 Backend 启动（重试计数已重置）。'
    } catch (error) {
      state.error = error instanceof Error ? error.message : 'Backend 启动失败'
    } finally {
      state.writing = false
    }
  }

  async function cancelRetry() {
    if (state.writing) return
    state.writing = true
    state.error = ''
    state.message = ''
    try {
      const result = await request<{ data: BackendPluginStatus }>('/api/backend-plugin/cancel-retry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      state.status = result.data
      state.message = '已取消自动重试，Backend 保持在异常停止状态。'
    } catch (error) {
      state.error = error instanceof Error ? error.message : '取消重试失败'
    } finally {
      state.writing = false
    }
  }

  async function saveAutoStart(autoStart: boolean) {
    if (state.writing) return
    state.writing = true
    state.error = ''
    state.message = ''
    try {
      const result = await request<{ data: { autoStart: boolean } }>('/api/backend-plugin/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoStart }),
      })
      if (state.status) state.status.autoStart = result.data.autoStart
      state.message = result.data.autoStart
        ? '已开启“随插件启动 Backend”（已持久化保存并回读确认）。'
        : '已关闭“随插件启动 Backend”（已持久化保存并回读确认）。'
    } catch (error) {
      state.error = error instanceof Error ? error.message : '随插件启动设置保存失败'
    } finally {
      state.writing = false
    }
  }

  return { state, read, start, cancelRetry, saveAutoStart, stop, setEnabled, resolveStop }
}
