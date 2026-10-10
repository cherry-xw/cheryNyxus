export class CapabilityError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message)
  }
}
export function invalid(message = '请求内容无效'): never {
  throw new CapabilityError('invalid_params', 400, message)
}
export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function unavailable(): CapabilityError {
  return new CapabilityError('unavailable', 503, '后端不可用，请检查连接后重试；未使用本地文件替代')
}

export function invalidHttpUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048) invalid('服务地址无效')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    invalid('服务地址无效')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash)
    invalid('服务地址必须是 HTTP(S) 地址，且不能包含账号、密码或片段')
  return url
}
