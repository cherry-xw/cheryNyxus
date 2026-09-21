/**
 * platform.wsUrl 远端分支单测。
 *
 * 背景（LAN 登录"登录失败"根因）：远端访问时 wsUrl() 曾第一优先返回 `/api/config`
 * 的 cfg.wsUrl（后端按本机请求 Host 生成，如 ws://localhost:8182），远端浏览器的
 * localhost 指向它自己那台机器 → WS 连不上 → 登录对话框兜底显示"登录失败"
 * （密码本身正确，登录 POST 已返回双 token）。
 *
 * 覆盖：
 * - 远端 + wsPath：跟随用户填写的地址主机（cfg.wsUrl 在场也必须被忽略）
 * - 远端 https 地址：wss 协议映射
 * - 远端无 wsPath：回退地址主机 + wsPort（地址带端口时不得拼成双端口）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureServiceAuth, serviceAuth } from '@/services/authContext'
import { wsUrl } from '@/services/platform'
import type { ServerConfig } from '@/services/platform'

function remoteAuth(baseUrl: string) {
  configureServiceAuth({
    isRemote: () => true,
    baseUrl: () => baseUrl,
    accessToken: () => 'tok',
    headers: () => ({ Authorization: 'Bearer tok' }),
    refresh: async () => true,
  })
}

const config = (overrides: Partial<ServerConfig> = {}): ServerConfig => ({
  wsPort: 8182,
  webPort: 8183,
  transport: 'json',
  ...overrides,
})

describe('wsUrl 远端分支', () => {
  beforeEach(() => remoteAuth('http://192.168.68.164:5173'))
  afterEach(() => {
    // 恢复默认本地端口，避免污染其他用例的模块级状态。
    configureServiceAuth({
      isRemote: () => false,
      baseUrl: () => '',
      accessToken: () => '',
      headers: () => ({}),
      refresh: async () => false,
    })
  })

  it('远端 + wsPath：忽略 cfg.wsUrl，跟随用户填写的地址主机', () => {
    // cfg.wsUrl 是后端按本机请求 Host 生成的（代理后恒为 localhost），远端必须忽略。
    const cfg = config({ wsPath: '/ws', wsUrl: 'ws://localhost:8182' })
    expect(wsUrl(cfg)).toBe('ws://192.168.68.164:5173/ws')
  })

  it('远端 https 地址：wss 协议映射', () => {
    remoteAuth('https://example.com:8443')
    expect(wsUrl(config({ wsPath: '/ws' }))).toBe('wss://example.com:8443/ws')
  })

  it('远端无 wsPath：回退地址主机名 + wsPort（不拼成双端口）', () => {
    const cfg = config({ wsPort: 8182 })
    expect(wsUrl(cfg)).toBe('ws://192.168.68.164:8182')
  })

  it('远端 + 地址带子路径：wsPath 前缀跟随地址路径', () => {
    remoteAuth('http://192.168.68.164:5173/chery/')
    expect(wsUrl(config({ wsPath: '/ws' }))).toBe('ws://192.168.68.164:5173/chery/ws')
  })
})
