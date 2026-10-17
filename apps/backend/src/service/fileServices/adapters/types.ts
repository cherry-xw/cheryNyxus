import type { FileCapabilityOperation, MessagePart } from '@chery/protocol'

export interface FileServiceAdapterAsset {
  assetId: string
  assetVersionId: string
  mimeType: string
  data: Buffer
}

export interface FileServiceAdapterInput {
  adapter: string
  operation: FileCapabilityOperation
  connection: {
    baseUrl: string
    model: string
    key?: string
    authType?: 'bearer' | 'x-api-key' | 'query-key' | 'none'
    endpoints?: Partial<Record<FileCapabilityOperation, string>>
  }
  params: Record<string, unknown>
  assets: FileServiceAdapterAsset[]
  signal?: AbortSignal
  providerContinuation?: Record<string, unknown>
}

export type FileServiceAdapterPart =
  | { type: 'text'; text: string }
  | { type: 'file'; data: Buffer; mimeType: string; originalName: string }

export interface FileServiceAdapterOutput {
  parts: FileServiceAdapterPart[]
  /** 已收到部分输出；retryable 仅表示可重新取得原响应中的文件。 */
  incomplete?: { code: string; message: string; retryable: boolean }
  providerContinuation?: Record<string, unknown>
  usage?: Record<string, unknown>
  remoteJobId?: string
}

export interface FileServiceAdapterDependencies {
  /** 仅在重新解析同一份已暂存响应时，按原位置复用已保存的前序输出。 */
  savedParts?: readonly FileServiceAdapterPart[]
  fetch?: typeof globalThis.fetch
  timeoutMs?: number
  /**
   * Trusted application downloader. Must resolve and pin public IP addresses,
   * revalidate every redirect, and never send provider credentials or cookies.
   * No default downloader is installed: URL results fail closed without this hook.
   * The adapter still limits the returned response body to 100 MiB.
   */
  download?: (url: URL, options: { signal: AbortSignal; maxBytes: number }) => Promise<Response>
}

export class FileServiceAdapterError extends Error {
  /** 已由受控本地工具保存的部分成果，不把失败改写成完整成功。 */
  outputParts?: MessagePart[]
  partialOutput?: FileServiceAdapterOutput
  constructor(
    public readonly code: string,
    message: string,
    public readonly providerCode?: string,
    public readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'FileServiceAdapterError'
  }
}
