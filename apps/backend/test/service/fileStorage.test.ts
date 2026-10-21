import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Database from 'better-sqlite3'
import { describe, expect, it } from 'vitest'
import { initAssetTables } from '@/db/assets.js'
import { getSoulDb } from '@/db/index.js'
import { AssetStore } from '@/service/media/assetStore.js'
import { createChat, deleteChat } from '@/db/chat.js'
import { addMessage, getMessages, parseMessageRow, fillApprovalResult } from '@/db/message.js'
import { addPendingInput, listPendingInputs } from '@/db/pendingInput.js'
import { parseStoredParts, normalizeMessageParts } from '@/utils/messageParts.js'
import { randomUUID } from 'node:crypto'
import type { FileOperationRecord, MessagePart } from '@chery/protocol'
import sharp from 'sharp'
import { adaptAssetImage } from '@/service/media/adaptImage.js'

describe('文件存储与消息', () => {
  it('真实编码的透明图片适配保留原版，固定版本重开仍可读取', async () => {
    const root = await mkdtemp(join(tmpdir(), 'image-adaptation-'))
    const db = new Database(join(root, 'assets.db'))
    db.exec('CREATE TABLE chats (id TEXT PRIMARY KEY)')
    initAssetTables(db)
    const store = new AssetStore(db, join(root, 'files'))
    try {
      const original = await sharp({ create: { width: 64, height: 32, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 0.5 } } }).png().toBuffer()
      const asset = await store.save(original, { ownerId: 'owner', originalName: 'transparent.png', mimeType: 'image/png', kind: 'image', source: 'upload' })
      const before = db.prepare('SELECT count(*) AS n FROM asset_versions').get()
      const reused = await adaptAssetImage(store, asset.id, { ownerId: 'owner' }, { quality: 1 })
      expect(reused.versionId).toBe(asset.versionId)
      expect(db.prepare('SELECT count(*) AS n FROM asset_versions').get()).toEqual(before)
      expect((await store.read(reused.id, { ownerId: 'owner' }, reused.versionId)).data).toEqual(original)
      const adapted = await adaptAssetImage(store, asset.id, { ownerId: 'owner' }, { maxEdge: 16, quality: 85 })
      expect(adapted.id).toBe(asset.id)
      expect(adapted.versionId).not.toBe(asset.versionId)
      const reopened = new AssetStore(db, join(root, 'files'))
      expect((await reopened.read(asset.id, { ownerId: 'owner' }, asset.versionId)).data).toEqual(original)
      const metadata = await sharp((await reopened.read(asset.id, { ownerId: 'owner' }, adapted.versionId)).data).metadata()
      expect(metadata).toMatchObject({ width: 16, height: 8, hasAlpha: true, format: 'png' })
      await expect(adaptAssetImage(store, asset.id, { ownerId: 'other' })).rejects.toThrow('无权访问')
      const count = db.prepare('SELECT count(*) AS n FROM asset_versions').get()
      await expect(adaptAssetImage(store, asset.id, { ownerId: 'owner' }, { maxBytes: 1 })).rejects.toThrow('硬上限')
      expect(db.prepare('SELECT count(*) AS n FROM asset_versions').get()).toEqual(count)
      expect((await store.read(asset.id, { ownerId: 'owner' }, asset.versionId)).data).toEqual(original)
    } finally { db.close(); await rm(root, { recursive: true, force: true }) }
  })

  it('最小检查：去重不合并权限，有序消息和队列保存固定版本及处理状态', async () => {
    const root = await mkdtemp('/tmp/opencode/file-storage-')
    const db = new Database(join(root, 'assets.db'))
    const chatId = randomUUID()
    db.pragma('foreign_keys = ON')
    db.exec('CREATE TABLE chats (id TEXT PRIMARY KEY)')
    initAssetTables(db)
    db.prepare('INSERT INTO chats VALUES (?)').run(chatId)
    const store = new AssetStore(db, join(root, 'files'))
    let persistedAssetId: string | undefined
    try {
      const bytes = Buffer.from('plain text file')
      const options = { ownerId: 'owner-a', originalName: '../note.txt', mimeType: 'text/plain', kind: 'document' as const, source: 'upload' as const }
      const a = await store.save(bytes, options)
      const b = await store.save(bytes, { ...options, ownerId: 'owner-b' })
      expect(a.sha256).toBe(b.sha256)
      expect(a.id).not.toBe(b.id)
      expect(a.originalName).toBe('note.txt')
      expect(a).not.toHaveProperty('path')
      expect(() => store.get(a.id, { ownerId: 'owner-b' })).toThrow('文件不存在或无权访问')
      expect(() => store.get(a.id, { ownerId: 'owner-a', chatId })).toThrow()
      const parts: MessagePart[] = [
        { partId: 't1', type: 'text', text: '先看说明' },
        { partId: 'a1', type: 'asset', assetId: a.id, assetVersionId: a.versionId, variant: 'original', usage: 'reference-only' },
        { partId: 'r1', type: 'role_mention', roleName: 'writer' },
        { partId: 'd1', type: 'directive', command: '/check' },
        { partId: 'w1', type: 'workspace_ref', path: 'note.txt', kind: 'file' },
        { partId: 't2', type: 'text', text: '最后一句' },
      ]
      expect(() => store.reference(parts, { ownerId: 'owner-a', chatId }, 'message', 'm')).toThrow()
      store.attachOwned(parts, { ownerId: 'owner-a', chatId }, 'message', 'm')
      expect((await store.read(a.id, { ownerId: 'owner-a', chatId }, a.versionId)).data).toEqual(bytes)
      await expect(store.readChunk(a.id, { ownerId: 'owner-b', chatId }, a.versionId, 0)).rejects.toThrow('无权访问')
      await expect(store.readChunk(a.id, { ownerId: 'owner-a' }, a.versionId, -1)).rejects.toThrow('位置无效')
      expect(await store.readChunk(a.id, { ownerId: 'owner-a', chatId }, a.versionId, 0)).toMatchObject({ dataBase64: bytes.toString('base64'), offset: 0, eof: true })
      expect(store.cleanup(Date.now() + 25 * 3_600_000)).toBe(1)
      // b 已清理，但与 a 共用的二进制内容不能删除。
      expect((await store.read(a.id, { ownerId: 'owner-a', chatId })).data).toEqual(bytes)

      createChat(chatId)
      const persistedStore = new AssetStore(getSoulDb(), join(root, 'persistent-files'))
      const persistedAsset = await persistedStore.save(bytes, options)
      persistedAssetId = persistedAsset.id
      const persistedParts = parts.map(part => part.type === 'asset' ? { ...part, assetId: persistedAsset.id, assetVersionId: persistedAsset.versionId } : part)
      persistedStore.attachOwned(persistedParts, { ownerId: 'owner-a', chatId }, 'pending', 'input')
      const operation: FileOperationRecord = {
        operationId: 'op', operation: 'document.extract', inputAssets: [], targetKind: 'tool',
        targetId: 'extract', executionStatus: 'succeeded', deliveryStatus: 'delivery_failed',
        inspectionStatus: 'not_requested', createdAt: 1, updatedAt: 2,
      }
      const row = addMessage('ordered', chatId, {
        role: 'assistant', content: '不能覆盖 parts', parts: persistedParts, fileOperations: [operation],
        thinkingBlocks: [{ type: 'thinking', thinking: 'reason', signature: 'signed' }],
        providerContinuation: { thoughtSignature: 'continuation' },
      })
      const restored = parseMessageRow(getMessages(chatId)[0]!)
      expect(restored.parts).toEqual(persistedParts)
      expect(restored.content).toBe(normalizeMessageParts(undefined, persistedParts).content)
      expect(restored.content).not.toContain('[[media:')
      expect(restored.fileOperations).toEqual([operation])
      expect(restored.thinkingBlocks).toEqual(JSON.parse(row.thinking_blocks!))
      expect(restored.providerContinuation).toEqual({ thoughtSignature: 'continuation' })
      addPendingInput({ inputId: 'input', chatId, messageId: 'queued', commandId: 'command', content: 'ignored', parts: persistedParts, queueSequence: 1, state: 'queued', acceptedAt: 1 })
      expect(parseStoredParts(listPendingInputs(chatId)[0]!.parts)).toEqual(persistedParts)
      addMessage('sense', chatId, { role: 'sense' })
      fillApprovalResult(chatId, 'sense', { parts: persistedParts, fileOperations: [operation] })
      expect(parseMessageRow(getMessages(chatId).find((message) => message.id === 'sense')!).parts).toEqual(persistedParts)
      expect(() => normalizeMessageParts('', [parts[0]!, parts[0]!])).toThrow('partId')
      expect(() => parseStoredParts('{broken')).toThrow()
      store.release(chatId, 'message', 'm', 0)
      expect(store.cleanup(Date.now() + 25 * 3_600_000)).toBe(1)
    } finally {
      deleteChat(chatId)
      if (persistedAssetId) getSoulDb().prepare('DELETE FROM assets WHERE id = ?').run(persistedAssetId)
      db.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
