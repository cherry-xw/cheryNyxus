import { createHttpContext } from './http.js'
import { validateFileServiceAdapterParams, type HttpFileServiceAdapterId } from './params.js'
import { assertInput, providerExecutors } from './providers.js'
import {
  FileServiceAdapterError,
  type FileServiceAdapterDependencies,
  type FileServiceAdapterInput,
  type FileServiceAdapterOutput,
} from './types.js'

export * from './types.js'
export { FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, validateFileServiceAdapterParams } from './params.js'
export { MAX_FILE_SERVICE_OUTPUT_BYTES } from './http.js'

/** One synchronous provider operation; no automatic retries, polling or paid fallback. */
export async function executeFileServiceAdapter(
  input: FileServiceAdapterInput,
  dependencies: FileServiceAdapterDependencies = {},
): Promise<FileServiceAdapterOutput> {
  assertInput(input)
  const params = validateFileServiceAdapterParams(input.adapter, input.params, input.connection.model)
  const timeoutMs = dependencies.timeoutMs ?? 600_000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new FileServiceAdapterError('file_service.invalid_config', 'timeoutMs 必须为有效的正整数毫秒数')
  }
  const controller = new AbortController()
  const aborted = new FileServiceAdapterError('file_operation.cancelled', '已停止等待；远端可能仍会完成，不会自动重试')
  const timedOut = new FileServiceAdapterError('file_operation.timeout', '文件操作等待超时；远端结果可能未知，不会自动重试')
  const cancel = () => controller.abort(aborted)
  input.signal?.addEventListener('abort', cancel, { once: true })
  if (input.signal?.aborted) cancel()
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(timedOut), timeoutMs) : undefined
  const ctx = createHttpContext(input, dependencies, controller.signal)
  let rejectAbort: (() => void) | undefined
  try {
    controller.signal.throwIfAborted()
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectAbort = () => reject(controller.signal.reason)
      controller.signal.addEventListener('abort', rejectAbort, { once: true })
    })
    const result = await Promise.race([providerExecutors[input.adapter as HttpFileServiceAdapterId](input, params, ctx), interrupted])
    const requested = input.adapter === 'google-imagen' ? Number(params.sampleCount ?? 1)
      : ['minimax-images', 'openai-images'].includes(input.adapter) ? Number(params.n ?? 1) : undefined
    const returned = result.parts.filter(part => part.type === 'file').length
    if (!ctx.incomplete && requested !== undefined && returned < requested) {
      ctx.incomplete = { code: 'file_service.output_incomplete', message: `请求 ${requested} 张图片，实际取得 ${returned} 张；不会自动重新生成缺失图片`, retryable: false }
    }
    return { ...result, ...(ctx.incomplete ? { incomplete: ctx.incomplete } : {}) }
  } catch (error) {
    // Never return an upstream fetch error with a possibly credential-bearing URL.
    const failure = controller.signal.aborted ? controller.signal.reason as FileServiceAdapterError
      : error instanceof FileServiceAdapterError ? error
        : new FileServiceAdapterError('file_operation.result_unknown', '文件服务连接中断；远端结果可能未知，不会自动重试')
    if (ctx.outputParts.some(part => part.type === 'file')) {
      const response = ctx.response ?? {}
      failure.partialOutput = {
        parts: [...ctx.outputParts],
        incomplete: { code: failure.code, message: failure.message,
          retryable: ['file_operation.delivery_failed', 'file_operation.cancelled', 'file_operation.timeout'].includes(failure.code) },
        ...(typeof response.id === 'string' ? { remoteJobId: response.id } : {}),
        ...(response.usage && typeof response.usage === 'object' ? { usage: response.usage as Record<string, unknown> } : {}),
      }
    }
    throw failure
  } finally {
    if (timer) clearTimeout(timer)
    input.signal?.removeEventListener('abort', cancel)
    if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort)
  }
}
