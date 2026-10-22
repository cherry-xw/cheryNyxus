import { imageParameterErrors, FILE_SERVICE_ADAPTER_PARAM_SCHEMAS } from '@chery/protocol'
import { FileServiceAdapterError } from './types.js'
export { FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, type HttpFileServiceAdapterId } from '@chery/protocol'

export function invalid(message: string): never {
  throw new FileServiceAdapterError('file_service.invalid_params', message)
}

export function validateFileServiceAdapterParams(adapter: string, params: Record<string, unknown>, model: string): Record<string, unknown> {
  if (!Object.hasOwn(FILE_SERVICE_ADAPTER_PARAM_SCHEMAS, adapter)) throw new FileServiceAdapterError('capability.unavailable', `不支持 HTTP 文件适配器：${adapter}`)
  const errors = imageParameterErrors(adapter, params, model)
  if (errors.length) invalid(errors.join('; '))
  return params
}
