import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:https'
import { connect, createServer as createTcpServer } from 'node:net'
import sharp from 'sharp'
import config from '@/utils/config.js'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { createIngressCoreAdapter } from '@/service/ingress/coreAdapter.js'
import { getAssetStore } from '@/service/media/store.js'
import { deleteChat } from '@/db/chat.js'
import { prepareQQFileInputs } from '../../../../plugins/qq/src/assetMessages.js'
import { planFileInputs } from '@/agent/middleware/fileInputPlanning.js'
import { buildOpenAICompatibleMessages } from '@/agent/provider/openaiCompat.js'
import { createMockContext, createMockRuntime } from '../agent/helpers/fakeContext.js'

const fixture = vi.hoisted(() => ({ port: 0, calls: [] as unknown[], dns: [{ address: '8.8.8.8', family: 4 }], path: '/image' }))
vi.mock('node:dns/promises', () => ({ lookup: vi.fn(async (host: string) => host === 'private.invalid' ? [{ address: '127.0.0.1', family: 4 }] : fixture.dns) }))
vi.mock('node:https', async importOriginal => {
  const actual = await importOriginal<typeof import('node:https')>()
  return { ...actual, request: (url: URL, options: any, listener: any) => {
    // Isolated transport mapping only: production validation/lookup runs unchanged.
    // Node's real socket asks for all:true and consumes the returned objects.
    const lookup = (host: string, opts: any, cb: any) => options.lookup(host, opts, (error: Error | null, addresses: any, family: number) => {
      fixture.calls.push({ options: opts, addresses, family })
      if (error) return cb(error)
      cb(null, Array.isArray(addresses) ? addresses.map(a => ({ ...a, address: '127.0.0.1', family: 4 })) : '127.0.0.1', family)
    })
    return actual.request(new URL(`https://fixture.invalid:${fixture.port}${url.pathname}`), { ...options, agent: false, lookup, rejectUnauthorized: false }, listener)
  } }
})
import { downloadProviderResult, pinnedPublicLookup } from '@/service/fileServices/download.js'

let root: string, bytes: Buffer, server: ReturnType<typeof createServer>
beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'provider-download-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem'), '-subj', '/CN=fixture.invalid', '-days', '1'], { stdio: 'ignore' })
  bytes = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#246898' } }).png().toBuffer()
  server = createServer({ key: readFileSync(join(root, 'key.pem')), cert: readFileSync(join(root, 'cert.pem')) }, (req, res) => {
    if (req.url === '/expired') { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('upstream signature details must not be logged'); return }
    if (req.url === '/redirect') { res.writeHead(302, { location: 'https://private.invalid/secret' }); res.end(); return }
    if (req.url === '/large') { res.writeHead(200, { 'content-length': 101 * 1024 * 1024 }); res.end(); return }
    if (req.url === '/invalid') { res.writeHead(200, { 'content-type': 'image/png' }); res.end('not an image'); return }
    res.writeHead(200, { 'content-type': 'image/png' }); res.end(bytes)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  fixture.port = (server.address() as import('node:net').AddressInfo).port
})
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) })

describe('pinned DNS lookup and real HTTPS import', () => {
  it.each([false, true])('honors all=%s and IPv4/IPv6 family/options', all => {
    const addresses = [{ address: '8.8.8.8', family: 4 }, { address: '2606:4700:4700::1111', family: 6 }]
    const lookup = pinnedPublicLookup(addresses)
    for (const family of [0, 4, 6, 'IPv4', 'IPv6']) {
      const cb = vi.fn(); lookup('unused.invalid', { all, family } as any, cb)
      const selected = addresses.filter(a => !family || a.family === (family === 'IPv4' ? 4 : family === 'IPv6' ? 6 : family))
      if (all) expect(cb).toHaveBeenCalledWith(null, selected)
      else expect(cb).toHaveBeenCalledWith(null, selected[0]!.address, selected[0]!.family)
    }
    addresses[0]!.address = '127.0.0.1'
    const cb = vi.fn(); lookup('unused.invalid', { all: true }, cb)
    expect(cb.mock.calls[0]![1][0].address).toBe('8.8.8.8')
  })
  it('rejects empty, malformed, mismatched and any private resolution', () => {
    for (const addresses of [[], [{ address: 'undefined', family: 4 }], [{ address: '8.8.8.8', family: 6 }], [{ address: '127.0.0.1', family: 4 }], [{ address: '::ffff:8.8.8.8', family: 6 }], [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]])
      expect(() => pinnedPublicLookup(addresses)).toThrow('不允许')
    const cb = vi.fn(); pinnedPublicLookup([{ address: '8.8.8.8', family: 4 }])('x', { family: 6 }, cb)
    expect(cb.mock.calls[0]![0]).toMatchObject({ code: 'EAI_ADDRFAMILY' })
  })
  it('real Node socket consumes all:false without disabling family selection globally', async () => {
    const lookup = pinnedPublicLookup([{ address: '8.8.8.8', family: 4 }])
    await new Promise<void>((resolve, reject) => {
      const socket = connect({ host: 'fixture.invalid', port: fixture.port, family: 4, lookup: (host, options, cb) => lookup(host, options, (error, address, family) => { expect(typeof address).toBe('string'); cb(error, '127.0.0.1', family) }) })
      socket.once('connect', () => { socket.destroy(); resolve() }); socket.once('error', reject)
    })
  })
  it.each([false, true])('real IPv6 socket consumes all=%s with the pinned IPv6 family', async all => {
    const tcp = createTcpServer(socket => socket.end())
    await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(0, '::1', resolve) })
    try {
      const lookup = pinnedPublicLookup([{ address: '2606:4700:4700::1111', family: 6 }])
      await new Promise<void>((resolve, reject) => {
        const socket = connect({ host: 'fixture.invalid', port: (tcp.address() as import('node:net').AddressInfo).port, ...(all ? { autoSelectFamily: true } : { family: 6 }), lookup: (host, options, callback) => {
          expect(!!options.all).toBe(all)
          lookup(host, options, (error, address, family) => {
            if (error) return callback(error, '', 0)
            if (all) { expect(address).toEqual([{ address: '2606:4700:4700::1111', family: 6 }]); callback(null, [{ address: '::1', family: 6 }]) }
            else { expect(address).toBe('2606:4700:4700::1111'); expect(family).toBe(6); callback(null, '::1', 6) }
          })
        } })
        socket.once('connect', () => { socket.destroy(); resolve() }); socket.once('error', reject)
      })
    } finally { await new Promise<void>(resolve => tcp.close(() => resolve())) }
  })
  it('downloads actual TLS bytes using Node all:true, validates each redirect and size', async () => {
    const response = await downloadProviderResult('https://public.invalid/image?signature=secret')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
    expect(fixture.calls).toContainEqual(expect.objectContaining({ options: expect.objectContaining({ all: true }), addresses: [{ address: '8.8.8.8', family: 4 }] }))
    await expect(downloadProviderResult('https://public.invalid/redirect')).rejects.toThrow('不允许')
    await expect(downloadProviderResult('https://public.invalid/large')).rejects.toThrow('大小限制')
    await expect(downloadProviderResult('http://public.invalid/image')).rejects.toThrow('不安全')
  })
  it('URL→download→sniff→save/grant→QQ parts→native image preserves original bytes without model calls', async () => {
    bootstrapAgentRuntime()
    const core = createIngressCoreAdapter(), owner = 'download-fixture', key = 'fixture-' + Date.now()
    const { chatId } = await core.ensureConversation(owner, key, Object.keys(config.presets!)[0]!)
    const identity = { requestIdentity: { source: 'plugin' as const, ownerId: owner, entryId: 'qq' }, validateIdentity() {} }
    const input = { eventId: 'fixture', selfId: '111', conversationType: 'group' as const, targetId: '222', senderId: '333', senderName: 'fixture', messageId: '444', content: 'fixture', mentionedBot: true, occurredAt: 1, attachments: [{ type: 'image', url: 'https://public.invalid/image?signature=secret' }] }
    try {
      const imported=await core.importFile!(owner,key,{...identity,entryId:'qq',originalName:'fixture.png',mimeType:'application/octet-stream',source:{url:input.attachments[0]!.url}})
      const parts=await prepareQQFileInputs([input],async()=>{throw Error('QQ must not download')},new AbortController().signal,{messages:[input],known:{[JSON.stringify(['111','group','222','444',0])]:{type:'asset',partId:'provider-output',assetId:imported.id,assetVersionId:imported.versionId,variant:'original',usage:'content',kind:'image'}},save(){},validate:async()=>{}})
      const part = parts!.find(p => p.type === 'asset')!
      if (part.type !== 'asset') throw Error('Missing asset')
      const store = getAssetStore(), read = await store.read(part.assetId, { ownerId: owner, chatId }, part.assetVersionId)
      expect(read.data).toEqual(bytes); expect(read.asset.mimeType).toBe('image/png')
      const ctx = createMockContext({ runtime: createMockRuntime({ brain: { provider: 'openai', protocol: 'openai-chat-completions', capabilities: { imageInput: { formats: ['image/png'] }, input: { image: 'supported' } } } }) }); ctx.soul.chatId = chatId
      const plan = await planFileInputs(ctx, [{ id: 'fixture', role: 'user', content: '', parts, createdAt: 1, updateAt: 1 }])
      const serialized = buildOpenAICompatibleMessages(plan.history, plan.attachments)
      const content = serialized[0]!.content as Array<{ type: string; image_url?: { url: string } }>
      const url = content.find(p => p.type === 'image_url')!.image_url!.url
      expect(Buffer.from(url.split(',')[1]!, 'base64')).toEqual(bytes)
      expect(JSON.stringify(serialized)).not.toContain('signature')
      await expect(store.read(part.assetId, { ownerId: 'other', chatId }, part.assetVersionId)).rejects.toThrow('无权')
      await expect(core.importFile!(owner, key, { ...identity, entryId: 'qq', originalName: 'bad.png', mimeType: 'image/png', source: { url: 'https://public.invalid/invalid' } })).rejects.toMatchObject({ stage: 'invalid', code: 'FILE_INVALID', cause: expect.any(Error) })
      await expect(core.importFile!(owner, key, { ...identity, entryId: 'qq', originalName: 'expired.jpg', mimeType: 'image/jpeg', source: { url: 'https://public.invalid/expired' } })).rejects.toMatchObject({ stage: 'download', code: 'HTTP_400' })
      await expect(core.importFile!(owner, key, { ...identity, entryId: 'qq', originalName: 'bad.png', mimeType: 'image/png', source: { url: 'https://private.invalid/image' } })).rejects.toMatchObject({ stage: 'download', code: 'REMOTE_ADDRESS_REJECTED' })
    } finally { deleteChat(chatId) }
  })
})
