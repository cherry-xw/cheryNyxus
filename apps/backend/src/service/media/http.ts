import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import config from '@/utils/config.js'
import { getAssetStore } from './store.js'
import { identifyFile } from './fileFormat.js'
import { fileAccessForChat } from './access.js'
import { adaptAssetImage } from './adaptImage.js'
import { resolveChatWorkspaceEntry } from '../workspace/sandbox.js'
import { saveAssetToWorkspace } from './workspace.js'
import { claimLegacyChatFiles } from './migration.js'
import { getFileRequestPlan } from '../fileServices/inputObservations.js'
import { getImageDescription, imageDescriptionIssue } from '../fileServices/imageContext.js'

export async function readBoundedBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  if (Number(req.headers['content-length'] ?? 0) > maxBytes) throw new Error('文件超过大小限制')
  const chunks: Buffer[] = []
  let total = 0
  for await (const item of req) {
    const chunk = Buffer.isBuffer(item) ? item : Buffer.from(item)
    total += chunk.length
    if (total > maxBytes) throw new Error('文件超过大小限制')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export function jsonResponse(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}

const assetRefs = z.object({ chatId: z.string().min(1).optional(), assets: z.array(z.object({ assetId: z.string().min(1), assetVersionId: z.string().min(1).optional() }).strict()).max(100) }).strict()

export async function handleAssetHttp(req: IncomingMessage, res: ServerResponse, ownerId: string): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (!url.pathname.startsWith('/api/assets/')) return false
  const store = getAssetStore()
  try {
    if (url.pathname === '/api/assets/image-descriptions' && req.method === 'POST') {
      const data = z.object({ chatId: z.string().min(1), assets: z.array(z.object({ assetId: z.string().min(1), assetVersionId: z.string().min(1) }).strict()).max(50) }).strict().parse(JSON.parse((await readBoundedBody(req, 32768)).toString()))
      fileAccessForChat(data.chatId, ownerId)
      jsonResponse(res, 200, { descriptions: data.assets.map(ref => {
        try { return { ...ref, description: getImageDescription(data.chatId, ref, ownerId), error: imageDescriptionIssue(data.chatId, ref, ownerId) } }
        catch { return { ...ref, error: '图片缺失或无权访问其说明' } }
      }) })
      return true
    }
    if (url.pathname === '/api/assets/request-plan' && req.method === 'POST') {
      const data = z.object({ chatId: z.string().min(1) }).strict().parse(JSON.parse((await readBoundedBody(req, 8192)).toString()))
      jsonResponse(res, 200, getFileRequestPlan(data.chatId, ownerId))
      return true
    }
    if (url.pathname === '/api/assets/draft' && req.method === 'POST') {
      const data = z.object({ draftId: z.string().min(1).max(200), assets: z.array(z.object({ assetId: z.string().min(1), assetVersionId: z.string().min(1) }).strict()).max(100) }).strict().parse(JSON.parse((await readBoundedBody(req, 128 * 1024)).toString()))
      store.retainDraft(data.assets, ownerId, data.draftId)
      jsonResponse(res, 200, { retained: data.assets.length })
      return true
    }
    if (url.pathname === '/api/assets/upload' && req.method === 'POST') {
      const body = await readBoundedBody(req, config.files?.maxUploadBytes ?? 100 * 1024 * 1024)
      const format = identifyFile(body, String(req.headers['content-type'] ?? 'application/octet-stream'))
      let name = String(req.headers['x-filename'] ?? 'file')
      try { name = decodeURIComponent(name) } catch { /* 非编码文件名保持原值。 */ }
      const asset = await store.save(body, { ownerId, originalName: name, source: 'upload', ...format, maxBytes: config.files?.maxUploadBytes })
      jsonResponse(res, 201, asset)
      return true
    }
    if (url.pathname === '/api/assets/get' && req.method === 'POST') {
      const data = assetRefs.parse(JSON.parse((await readBoundedBody(req, 128 * 1024)).toString('utf8')))
      const access = data.chatId ? fileAccessForChat(data.chatId, ownerId) : { ownerId }
      jsonResponse(res, 200, { assets: data.assets.map((ref) => {
        try { return store.get(ref.assetId, access, ref.assetVersionId) } catch { return { id: ref.assetId, missing: true } }
      }) })
      return true
    }
    if (url.pathname === '/api/assets/import-workspace' && req.method === 'POST') {
      const data = z.object({ chatId: z.string().min(1), path: z.string().min(1) }).strict().parse(JSON.parse((await readBoundedBody(req, 8192)).toString()))
      fileAccessForChat(data.chatId, ownerId)
      const entry = await resolveChatWorkspaceEntry(data.chatId, data.path)
      if (!entry.stat.isFile() || entry.stat.size > (config.files?.maxUploadBytes ?? 100 * 1024 * 1024)) throw new Error('只能导入大小限制内的普通文件')
      const body = await readFile(entry.absolute)
      const asset = await store.save(body, { ownerId, originalName: entry.relative, source: 'workspace', ...identifyFile(body, 'application/octet-stream'), maxBytes: config.files?.maxUploadBytes })
      jsonResponse(res, 201, asset)
      return true
    }
    if (url.pathname === '/api/assets/save-workspace' && req.method === 'POST') {
      const data = z.object({ chatId: z.string().min(1), assetId: z.string().min(1), assetVersionId: z.string().min(1), path: z.string().min(1) }).strict().parse(JSON.parse((await readBoundedBody(req, 8192)).toString()))
      jsonResponse(res, 201, await saveAssetToWorkspace(data, fileAccessForChat(data.chatId, ownerId), data.path))
      return true
    }
    if (url.pathname === '/api/assets/claim-history' && req.method === 'POST') {
      const data = z.object({ chatId: z.string().min(1), confirm: z.literal(true) }).strict().parse(JSON.parse((await readBoundedBody(req, 8192)).toString()))
      jsonResponse(res, 200, await claimLegacyChatFiles(data.chatId, ownerId))
      return true
    }
    const match = /^\/api\/assets\/([^/]+)(\/adapt)?$/.exec(url.pathname)
    if (match) {
      const chatId = url.searchParams.get('chatId') ?? undefined
      const access = chatId ? fileAccessForChat(chatId, ownerId) : { ownerId }
      if (match[2] && req.method === 'POST') {
        const options = z.object({ maxEdge: z.number().int().positive().optional(), quality: z.number().int().min(1).max(100).optional() }).strict()
          .parse(JSON.parse((await readBoundedBody(req, 8192)).toString() || '{}'))
        jsonResponse(res, 200, await adaptAssetImage(store, match[1]!, access, { ...config.files?.imageAdaptation, ...options }))
        return true
      }
      if (!match[2] && req.method === 'GET') {
        const { asset, data } = await store.read(match[1]!, access, url.searchParams.get('assetVersionId') ?? undefined)
        const safePreview = /^(image\/(png|jpeg|gif|webp)|audio\/|video\/)/.test(asset.mimeType)
        const download = url.searchParams.get('download') === '1' || !safePreview
        let start = 0
        let end = data.length - 1
        const range = req.headers.range
        if (range) {
          const parsed = /^bytes=(\d*)-(\d*)$/.exec(range)
          if (!parsed || !parsed[1] && !parsed[2]) { res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }); res.end(); return true }
          if (!parsed[1]) start = Math.max(0, data.length - Number(parsed[2]))
          else { start = Number(parsed[1]); if (parsed[2]) end = Math.min(Number(parsed[2]), data.length - 1) }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= data.length) { res.writeHead(416, { 'Content-Range': `bytes */${data.length}` }); res.end(); return true }
        }
        const body = data.subarray(start, end + 1)
        res.writeHead(range ? 206 : 200, { 'Content-Type': asset.mimeType, 'Content-Length': body.length, 'Accept-Ranges': 'bytes',
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${data.length}` } : {}),
          'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="file"; filename*=UTF-8''${encodeURIComponent(asset.originalName).replace(/'/g, '%27')}` })
        res.end(body)
        return true
      }
    }
    jsonResponse(res, 404, { error: { code: 'asset.not_found', message: '文件操作入口不存在' } })
  } catch (error) {
    const unavailable = (error as { code?: string }).code === 'ASSET_UNAVAILABLE'
    jsonResponse(res, unavailable ? 404 : 400, { error: { code: unavailable ? 'asset.unavailable' : 'INVALID_PARAMS', message: unavailable ? '文件不存在或无权访问' : (error as Error).message } })
  }
  return true
}
