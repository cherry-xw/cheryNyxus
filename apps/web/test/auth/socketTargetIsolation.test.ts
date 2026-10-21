import { describe, expect, it, vi } from 'vitest'
import { WsClient } from '../../src/services/ws'

class Socket {
  static OPEN = 1
  readyState = 1
  binaryType = ''
  sent: unknown[] = []
  onopen?: () => void
  onclose?: (event: { code: number; reason: string }) => void
  onmessage?: (event: { data: string }) => void
  onerror?: () => void
  send(data: unknown) { this.sent.push(data) }
  close() { this.readyState = 3 }
}

describe('socket target generations without browser UI', () => {
  it('rejects pending without replay and ignores late responses/close from the previous socket', async () => {
    const sockets: Socket[] = []
    const Constructor = class extends Socket { constructor(_url: string) { super(); sockets.push(this) } }
    vi.stubGlobal('WebSocket', Constructor)
    const client = new WsClient()
    const internal = client as unknown as { serverConfig: unknown; open(): void }
    try {
      internal.serverConfig = { wsPort: 8182, transport: 'json', wsUrl: 'ws://10.2.3.6:8182', wsTicket: 't'.repeat(32), wsPath: '/ws' }
      vi.stubGlobal('window', { location: { origin: 'http://10.2.3.6', protocol: 'http:', host: '10.2.3.6', hostname: '10.2.3.6' } })
      internal.open(); sockets[0]!.onopen!()
      const pending = client.rpc('chat.list')
      const rejected = expect(pending).rejects.toThrow('旧请求不会重发')
      client.disconnect(); await rejected
      internal.serverConfig = { wsPort: 8182, transport: 'json', wsUrl: 'ws://10.2.3.6:8182', wsTicket: 'u'.repeat(32), wsPath: '/ws' }
      internal.open(); sockets[1]!.onopen!()
      expect(sockets[1]!.sent).toEqual([])
      sockets[0]!.onclose!({ code: 1011, reason: 'late old close' })
      expect(client.getStatus()).toBe('connected')
      let notifications = 0; const off = client.onNotification(() => notifications++)
      sockets[0]!.onmessage!({ data: JSON.stringify({ kind: 'notification', type: 'late-old-target' }) })
      expect(notifications).toBe(0); off()
    } finally { client.disconnect(); vi.unstubAllGlobals() }
  })
})
