import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { RpcRouter } from '../../src/service/message/router'
import { OAuth2Auth } from '../../src/service/auth'
import { createWebSocketServer } from '../../src/service/websocket'
import { hashPassword } from '../../src/utils/password'
import { UserProofSigner } from '../../../relay/src/userProof'

describe('password and Pocket proof share actual Backend business permissions', () => {
  it('accepts the same RPC with each identity, rejects machine on remote and closes revoked proof WS over LAN', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const kid = 'k'.repeat(32)
    const issuer = 'https://relay.example/issuer'
    const signer = new UserProofSigner(issuer, kid, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString())
    const auth = new OAuth2Auth({ username: 'business', password: hashPassword('synthetic-business-password'), machine: { username: 'machine', password: hashPassword('synthetic-machine-password') }, userProof: { issuer, backendId: 'home-device', keys: { [kid]: publicKey.export({ format: 'pem', type: 'spki' }).toString() }, authorizations: [] } })
    auth.updateAuthorizations([{ id: 'binding', revision: 1, subject: 'pocket-user' }])
    const router = new RpcRouter()
    router.register('brain.list', async () => ({ brains: [], mcpServers: [] }))
    const server = createWebSocketServer({ port: 0, host: '0.0.0.0', listener: 'remote', router, auth, allowedOrigins: ['https://relay.example'] })
    await once(server, 'listening')
    const url = `ws://10.2.3.6:${(server.address() as { port: number }).port}/ws`
    const sockets: WebSocket[] = []
    async function connect(headers: Record<string, string>) { const ws = new WebSocket(url, { headers, origin: 'https://relay.example' }); sockets.push(ws); await once(ws, 'open'); return ws }
    async function call(ws: WebSocket) { const response = once(ws, 'message'); ws.send(JSON.stringify({ kind: 'request', id: 'permission-check', method: 'brain.list', params: {} })); return JSON.parse(String((await response)[0])) }
    try {
      const tokens = auth.authenticate('business', 'synthetic-business-password')!
      const password = await connect({ 'x-chery-relay-authorization': `Bearer ${tokens.accessToken}` })
      const proof = signer.issue({ sub: 'pocket-user', aud: 'home-device', sessionId: 's'.repeat(32), authorizationId: 'binding', authorizationRevision: 1, permissions: ['business'] }, 'GET', '/ws')
      const pocket = await connect({ 'x-chery-relay-user-proof': proof })
      expect(await call(password)).toMatchObject({ success: true, data: { brains: [] } })
      expect(await call(pocket)).toMatchObject({ success: true, data: { brains: [] } })
      const replay = new WebSocket(url, { headers: { 'x-chery-relay-user-proof': proof }, origin: 'https://relay.example' }); sockets.push(replay)
      replay.on('error', () => {})
      const refused = await new Promise<number>((resolve) => replay.on('unexpected-response', (_r, response) => { response.resume(); resolve(response.statusCode!); replay.terminate() }))
      expect(refused).toBe(401)
      const closed = once(pocket, 'close'); auth.updateAuthorizations([]); expect((await closed)[0]).toBe(4003)
      expect(await call(password)).toMatchObject({ success: true })
    } finally { for (const ws of sockets) ws.terminate(); await new Promise<void>((resolve) => server.close(() => resolve())) }
  })
})
