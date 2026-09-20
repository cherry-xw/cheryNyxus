import { ErrorCode } from './types.js'
import { newTracingId } from '@/utils/error.js'

/** Only messages deliberately written for users may leave this boundary. */
export function operationError(message: string): Error & { code: string } {
  return Object.assign(new Error(`[${newTracingId()}] ${message}`), {
    code: ErrorCode.INVALID_PARAMS,
  })
}

export async function userOperation<T>(run: () => T | Promise<T>, fallback: string): Promise<T> {
  try {
    return await run()
  } catch (cause) {
    const code = (cause as { code?: string })?.code
    if (cause instanceof Error && code === ErrorCode.INVALID_PARAMS) throw cause
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw operationError('文件或工作区已不存在，请刷新文件列表并检查工作区设置')
    if (code === 'EACCES' || code === 'EPERM') throw operationError('后端账号没有访问此路径的权限')
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_DLOPEN_FAILED')
      throw operationError('Terminal 运行依赖不可用，请重新安装依赖或更新桌面安装包')
    throw operationError(fallback)
  }
}
