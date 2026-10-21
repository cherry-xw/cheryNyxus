import { drain } from './streamFlow.js'
import { request as httpRequest } from 'node:http'
import { WebSocket } from 'ws'
import type { RelayTargetAdapter, RelayHttpRequest, RelayHttpResponse, RelayWebSocketRequest } from './adapter.js'
import type { BackendRegistry } from './registry.js'

/** Forwards only to the two loopback addresses assigned by the relay registry. */
export class LoopbackTunnelAdapter implements RelayTargetAdapter {
  constructor(private readonly registry: BackendRegistry) {}

  async forwardHttp(input: RelayHttpRequest): Promise<RelayHttpResponse> {
    const address = this.registry.tunnelAddresses(input.backendId).httpBindAddr
    const url = new URL(`http://${address}${input.path}`)
    return new Promise((resolve, reject) => {
      const request = httpRequest(url, {
        method: input.method,
        headers: input.headers,
        signal: input.signal,
      }, (response) => {
        resolve({ status: response.statusCode ?? 502, headers: response.headers, body: response })
      })
      request.once('error', reject)
      void (async () => {
        try {
          for await (const chunk of input.body) if (!request.write(chunk)) await drain(request)
          request.end()
        } catch (error) {
          request.destroy(error as Error)
          reject(error)
        }
      })()
    })
  }

  acceptWebSocket(input: RelayWebSocketRequest): void {
    const address = this.registry.tunnelAddresses(input.backendId).websocketBindAddr
    const upstream = new WebSocket(`ws://${address}${input.path}`, {
      handshakeTimeout: 5000,
      maxPayload: 16 * 1024 * 1024,
      headers: input.headers as Record<string, string | string[]>,
    })
    const queued: Array<{ data: import('ws').RawData; isBinary: boolean }> = []
    let queuedBytes = 0
    input.client.on('message', (data, isBinary) => {
      if (upstream.readyState === WebSocket.OPEN) {
        if (upstream.bufferedAmount > 1024 * 1024) return input.client.close(1009, 'Backpressure limit')
        upstream.send(data, { binary: isBinary })
      } else if (upstream.readyState === WebSocket.CONNECTING) {
        queuedBytes += Buffer.byteLength(data as Buffer)
        if (queuedBytes > 1024 * 1024) { input.client.close(1009, 'Queue limit'); upstream.terminate(); return }
        queued.push({ data, isBinary })
      }
    })
    upstream.once('open', () => {
      for (const item of queued) upstream.send(item.data, { binary: item.isBinary })
      queued.length = 0
      upstream.on('message', (data, isBinary) => {
        if (input.client.readyState === WebSocket.OPEN) {
          if (input.client.bufferedAmount > 1024 * 1024) { input.client.close(1009, 'Backpressure limit'); upstream.terminate(); return }
          input.client.send(data, { binary: isBinary })
        }
      })
    })
    const closeBoth = (code = 1011, reason = 'Backend unavailable') => {
      if (input.client.readyState === WebSocket.OPEN) input.client.close(code, reason)
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close(code, reason)
    }
    upstream.once('error', () => closeBoth())
    upstream.once('close', () => {
      if (input.client.readyState === WebSocket.OPEN) input.client.close(1011, 'Backend disconnected')
    })
    input.client.once('close', () => {
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, 'Browser disconnected')
      else if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate()
    })
  }
}
