import { deriveTextContentFromParts, type MessagePart } from '@chery/protocol'
import { setMcpToolResultHandler } from '@/core/mcp/convert.js'
import { fileAccessForChat } from './access.js'
import { getAssetStore } from './store.js'
import { identifyFile } from './fileFormat.js'
import { getSoulDb } from '@/db/index.js'

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function registerMcpFileResults(): void {
  setMcpToolResultHandler(async (result, runtime) => {
    const parts: MessagePart[] = []
    const limit = 100 * 1024 * 1024
    let total = 0
    const content = Array.isArray(result.content) ? result.content : []
    if (content.length > 1000) throw new Error('MCP 返回结果数量超过限制')
    try {
    for (const [index, raw] of content.entries()) {
      runtime?.signal?.throwIfAborted()
      const item = object(raw)
      const resource = object(item.resource)
      const partId = `mcp:${index}`
      const encoded = item.type === 'image' || item.type === 'audio' ? item.data : item.type === 'resource' ? resource.blob : undefined
      if (typeof encoded === 'string') {
        if (!runtime?.chatId || !runtime.messageId && !runtime.operationId) throw new Error('MCP 文件结果缺少会话或工具调用身份')
        if (!encoded || encoded.length > Math.ceil((limit - total) / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('MCP 文件内容无效或超过限制')
        const bytes = Buffer.from(encoded, 'base64')
        total += bytes.length
        if (total > limit) throw new Error('MCP 文件内容超过限制')
        const access = fileAccessForChat(runtime.chatId)
        const mime = typeof item.mimeType === 'string' ? item.mimeType : typeof resource.mimeType === 'string' ? resource.mimeType : 'application/octet-stream'
        const format = identifyFile(bytes, mime)
        const asset = await getAssetStore().save(bytes, { ownerId: access.ownerId, originalName: `mcp-result-${index + 1}`, source: 'tool', ...format })
        const part: MessagePart = { type: 'asset', partId, assetId: asset.id, assetVersionId: asset.versionId, variant: 'original', usage: 'content', originalName: asset.originalName, mimeType: asset.mimeType, kind: asset.kind }
        const operation = runtime.operationId && getSoulDb().prepare('SELECT 1 FROM file_operations WHERE operation_id = ? AND chat_id = ? AND owner_id = ?').get(runtime.operationId, runtime.chatId, access.ownerId)
        if (operation) getAssetStore().attachOwned([part], access, 'operation', runtime.operationId!)
        else if (runtime.messageId) getAssetStore().attachOwned([part], access, 'message', runtime.messageId)
        else throw new Error('MCP 文件结果没有可保存的调用记录')
        parts.push(part)
      } else {
        if (item.type === 'image' || item.type === 'audio' || item.type === 'resource' && resource.blob !== undefined) throw new Error('MCP 返回了无效文件内容')
        const text = item.type === 'text' ? item.text : item.type === 'resource' ? resource.text : item.type === 'resource_link' ? `[资源链接：${String(item.uri ?? '')}；尚未读取]` : `[不支持的 MCP 结果：${String(item.type)}]`
        if (typeof text !== 'string') throw new Error('MCP 返回了无效的文字或文件内容')
        total += Buffer.byteLength(text)
        if (total > limit) throw new Error('MCP 结果超过限制')
        parts.push({ type: 'text', partId, text })
      }
    }
    const structured = result.structuredContent === undefined ? undefined : JSON.stringify(result.structuredContent)
    if (structured && Buffer.byteLength(structured) + total > limit) throw new Error('MCP 结构化结果超过限制')
    return { content: structured ?? deriveTextContentFromParts(parts), parts, outputAssetIds: parts.filter(part => part.type === 'asset').map(part => part.assetId), status: 'ok', hash: '' }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'MCP 文件结果保存失败'
      parts.push({ type: 'text', partId: 'mcp:error', text: `MCP 结果未完整保存：${message}` })
      return { content: deriveTextContentFromParts(parts), parts, outputAssetIds: parts.filter(part => part.type === 'asset').map(part => part.assetId), status: 'provider_error', hash: '' }
    }
  })
}
