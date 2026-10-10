import { describe, expect, it } from 'vitest'
import { isLoopbackAddress, isLoopbackHost, readBackendNetworkFromConfig } from '../src/server.js'

// 认证 HTTP 与 OIDC 回归已迁入 apps/manager/test；运行 pnpm manager:test。
// 本路径保留无网络的公开辅助函数测试，既有文档和定向命令仍可定位。
describe('Manager listener helpers', () => {
  it('distinguishes loopback from remote listeners', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('::1')).toBe(true)
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddress('192.168.1.2')).toBe(false)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
  })
  it('provides backend network defaults without a backend process', async () => {
    expect(await readBackendNetworkFromConfig(undefined)).toEqual({ host: '127.0.0.1', wsPort: 8182, webPort: 8183 })
  })
})
