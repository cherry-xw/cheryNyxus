import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { isIP, type LookupFunction } from 'node:net'
import type { LookupAddress } from 'node:dns'

function downloadError(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code, stage: 'download' })
}

/** Pin the validated DNS snapshot; never resolve again inside the transport. */
export function pinnedPublicLookup(addresses: readonly LookupAddress[]): LookupFunction {
  if (!addresses.length || addresses.some(item => !publicAddress(item.address) || isIP(item.address) !== item.family))
    throw downloadError('REMOTE_ADDRESS_REJECTED', '远程结果地址不允许访问本机或内部网络')
  const pinned = addresses.map(item => ({ address: item.address, family: item.family }))
  return (_hostname, options, callback) => {
    const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family
    const matching = pinned.filter(item => !family || item.family === family)
    if (!matching.length) {
      callback(downloadError('EAI_ADDRFAMILY', '远程结果地址没有匹配的 IP 类型'), '', 0)
      return
    }
    if (options.all) callback(null, matching)
    else callback(null, matching[0]!.address, matching[0]!.family)
  }
}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number) as [number, number]
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && [0, 168].includes(b) || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19, 51].includes(b) || a === 203 && b === 0)
  }
  // Only global-unicast IPv6; reject mapped IPv4, local ranges and documentation prefixes.
  return isIP(address) === 6 && /^[23]/.test(address) && !/^2001:(db8|0|10|20):/i.test(address)
}

/** Provider result URLs have no connection credentials and never reach local networks. */
export async function downloadProviderResult(input: URL | string, signal?: AbortSignal, redirects = 0): Promise<Response> {
  const url = new URL(input)
  if (url.protocol !== 'https:' || url.username || url.password || redirects > 3) throw new Error('远程结果地址不安全')
  const addresses = await lookup(url.hostname, { all: true, verbatim: true })
  const pinned = pinnedPublicLookup(addresses)
  return new Promise((resolve, reject) => {
    const req = request(url, { signal,
      lookup: pinned,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        res.resume()
        if (!res.headers.location) return reject(new Error('远程结果跳转缺少地址'))
        downloadProviderResult(new URL(res.headers.location, url), signal, redirects + 1).then(resolve, reject)
        return
      }
      if ((res.statusCode ?? 500) >= 400) { res.resume(); reject(downloadError(`HTTP_${res.statusCode ?? 500}`, '远程结果下载失败')); return }
      const limit = 100 * 1024 * 1024
      if (Number(res.headers['content-length'] ?? 0) > limit) { res.destroy(); reject(new Error('远程结果超过大小限制')); return }
      const chunks: Buffer[] = []
      let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > limit) { res.destroy(new Error('远程结果超过大小限制')); return }
        chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('end', () => resolve(new Response(new Uint8Array(Buffer.concat(chunks)), { status: res.statusCode, headers: { 'content-type': String(res.headers['content-type'] ?? 'application/octet-stream') } })))
    })
    req.on('error', reject)
    req.end()
  })
}
