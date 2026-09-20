import type { IncomingHttpHeaders } from 'node:http'
import type { WebSocket } from 'ws'

export interface RelayHttpRequest {
  requestId: string
  backendId: string
  method: string
  path: string
  headers: IncomingHttpHeaders
  body: AsyncIterable<Buffer>
  signal: AbortSignal
}

export interface RelayHttpResponse {
  status: number
  headers?: IncomingHttpHeaders
  body?: Uint8Array | AsyncIterable<Uint8Array>
}

export interface RelayWebSocketRequest {
  requestId: string
  backendId: string
  path: '/ws'
  headers: IncomingHttpHeaders
  client: WebSocket
}

export interface RelayTargetAdapter {
  forwardHttp(request: RelayHttpRequest): Promise<RelayHttpResponse>
  acceptWebSocket(request: RelayWebSocketRequest): Promise<void> | void
}

export const unavailableTargetAdapter: RelayTargetAdapter = {
  async forwardHttp() {
    throw new Error('No relay target adapter configured')
  },
  acceptWebSocket({ client }) {
    client.close(1013, 'Backend unavailable')
  },
}
