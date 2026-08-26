const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** 从服务地址中提取 host（小写）。解析失败退化为取 `://` 后第一段。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return url.split('://')[1]?.split(/[/:]/)[0]?.toLowerCase() ?? ''
  }
}

/** 是否为 loopback host（本地直连不鉴权）。 */
export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true
  return host.startsWith('127.') || host.startsWith('::ffff:127.')
}

/** 补全 scheme（用户可能只输入 host:port）。 */
export function normalizeAddress(address: string): string {
  const trimmed = address.trim()
  if (!trimmed) return ''
  return trimmed.includes('://') ? trimmed : `http://${trimmed}`
}
