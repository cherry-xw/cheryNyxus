import { describe, expect, it } from 'vitest'
import { createPrivateServices, renderRatholeClientConfig, renderRatholeServerConfig } from '../src/rathole.js'

describe('rathole configuration', () => {
  it('creates only private HTTP and WebSocket services', () => {
    const services = createPrivateServices({
      httpLocalAddr: '127.0.0.1:8183',
      wsLocalAddr: '127.0.0.1:8182',
      httpBindAddr: '127.0.0.1:48081',
      wsBindAddr: '127.0.0.1:48082',
    })
    const client = renderRatholeClientConfig({ serverAddr: 'relay.example:2333', services })
    const server = renderRatholeServerConfig({ bindAddr: '0.0.0.0:2333', services })
    expect(client).toContain('local_addr = "127.0.0.1:8183"')
    expect(client).toContain('local_addr = "127.0.0.1:8182"')
    expect(server).toContain('bind_addr = "127.0.0.1:48081"')
    expect(server).toContain('bind_addr = "127.0.0.1:48082"')
    expect(server).not.toContain('39980')
    expect(services).toHaveLength(2)
  })
})
