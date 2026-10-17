import type { AssetRecord, FileOperationRecord } from '@chery/protocol'
import type { FilesConfigDto } from './agentApiTypes'
import { httpUrl } from './http'
import { serviceAuth } from './authContext'
import { sessionHeaders } from './platform'
import { fetchServerConfig, uploadFile } from './agentApiTransport'

export interface ImageDescription {
  text: string
  keywords: string[]
  source: string
  scope: string
  operationId?: string
  createdAt: number
}

export interface FileRequestPlan {
  status?: 'not_prepared'
  requestId?: string
  phase?: 'prepared' | 'sent' | 'completed' | 'failed_before_send' | 'result_unknown'
  policy?: FilesConfigDto['imageContext']
  updatedAt?: number
  usage?: { assetVersions: number; binaryBytes: number; extractedChars: number } | null
  tokenSource?: string
  officialPreflight?: string
  inputTokens?: number
  estimatedTextTokens?: number
  plan: Array<{ messageId: string; partId: string; assetId: string; assetVersionId: string; originalName?: string; variant: 'original' | 'adapted'; action: 'native' | 'extract' | 'tool' | 'describe' | 'omit'; reason: string; binaryBytes: number; extractedChars: number; targetId?: string; operationId?: string; truncated?: boolean; description?: ImageDescription; ageUserTurns?: number }>
}

async function request<T>(path: string, body?: unknown, method?: string): Promise<T> {
  const auth = serviceAuth()
  const context = auth.contextKey?.()
  const assertCurrent = () => {
    auth.assertCurrent?.()
    if (auth !== serviceAuth() || context !== auth.contextKey?.()) throw new Error('后端身份已改变，请重试')
  }
  assertCurrent()
  const server = await fetchServerConfig()
  assertCurrent()
  const response = await fetch(httpUrl(path), {
    method: method ?? (body === undefined ? 'GET' : 'POST'), credentials: 'include',
    headers: { ...sessionHeaders(server), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  assertCurrent()
  if (!response.ok) throw new Error(`文件请求失败 (${response.status})：${await response.text()}`)
  const result = await response.json() as T
  assertCurrent()
  return result
}

export const fileApi = {
  contextKey: () => serviceAuth().contextKey?.() ?? serviceAuth().baseUrl(),
  upload: (file: File) => uploadFile<AssetRecord>('/api/assets/upload', file, { contentType: file.type || 'application/octet-stream', errorMessage: '文件上传失败' }),
  get: (assets: Array<{ assetId: string; assetVersionId?: string }>, chatId?: string) =>
    request<{ assets: Array<AssetRecord | { id: string; missing: true }> }>('/api/assets/get', { assets, ...(chatId ? { chatId } : {}) }),
  imageDescription: (assets: Array<{ assetId: string; assetVersionId: string }>, chatId: string) =>
    request<{ descriptions: Array<{ assetId: string; assetVersionId: string; description?: ImageDescription; error?: string }> }>('/api/assets/image-descriptions', { chatId, assets }),
  adapt: (assetId: string, chatId?: string) => request<AssetRecord>(`/api/assets/${encodeURIComponent(assetId)}/adapt${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`, {}),
  retainDraft: (draftId: string, assets: Array<{ assetId: string; assetVersionId: string }>) => request('/api/assets/draft', { draftId, assets }),
  async read(assetId: string, assetVersionId: string, chatId?: string, download = false): Promise<Blob> {
    const auth = serviceAuth()
    const context = auth.contextKey?.()
    const assertCurrent = () => {
      auth.assertCurrent?.()
      if (auth !== serviceAuth() || context !== auth.contextKey?.()) throw new Error('后端身份已改变，请重试')
    }
    assertCurrent()
    const server = await fetchServerConfig()
    const query = new URLSearchParams({ assetVersionId, ...(chatId ? { chatId } : {}), ...(download ? { download: '1' } : {}) })
    assertCurrent()
    const response = await fetch(httpUrl(`/api/assets/${encodeURIComponent(assetId)}?${query}`), {
      credentials: 'include', headers: sessionHeaders(server),
    })
    if (!response.ok) throw new Error(`此文件暂时无法读取 (${response.status})`)
    const blob = await response.blob()
    assertCurrent()
    return blob
  },
  resolve: (body: unknown) => request<{ capabilities: Array<{ operation: string; availability: string; reason?: string; source?: string; targetId?: string; configRevision?: string }> }>('/api/file-services/resolve', body),
  requestPlan: (chatId: string) => request<FileRequestPlan>('/api/assets/request-plan', { chatId }),
  tryService: (body: unknown) => request<FileOperationRecord>('/api/file-services/try', body),
  operation: (id: string, chatId?: string) => request<FileOperationRecord>(`/api/file-operations/${encodeURIComponent(id)}${chatId ? `?chatId=${encodeURIComponent(chatId)}` : ''}`),
  cancel: (id: string) => request<FileOperationRecord>(`/api/file-operations/${encodeURIComponent(id)}/cancel`, {}),
  retry: (id: string, step: 'save' | 'execute', requestId: string) => request<FileOperationRecord>(`/api/file-operations/${encodeURIComponent(id)}/retry`, { step, requestId }),
  trials: (serviceId: string) => request<{ operations: FileOperationRecord[] }>('/api/file-operations/list', { serviceId }),
  deleteTrial: (id: string) => request(`/api/file-operations/${encodeURIComponent(id)}`, undefined, 'DELETE'),
}
