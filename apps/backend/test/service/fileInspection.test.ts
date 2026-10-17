import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createChat, deleteChat } from '@/db/chat.js'
import { getSoulDb } from '@/db/index.js'
import { recordFileInspection } from '@/service/fileServices/operations.js'
import type { FileOperationRecord } from '@chery/protocol'

describe('文件检查完成条件', () => {
  it('仅接收同会话且读取全部固定版本的成功理解记录', () => {
    const chatId = randomUUID()
    createChat(chatId, { fileOwnerId: 'inspection-owner' })
    const db = getSoulDb()
    const generated: FileOperationRecord = { operationId: randomUUID(), operation: 'image.generate', inputAssets: [], targetKind: 'tool', targetId: 'generator', executionStatus: 'succeeded', deliveryStatus: 'saved', inspectionStatus: 'pending_inspection', createdAt: 1, updatedAt: 1,
      outputParts: [{ type: 'asset', partId: 'file', assetId: 'asset', assetVersionId: 'original', variant: 'original', usage: 'content' }] }
    const evidence: FileOperationRecord = { operationId: randomUUID(), operation: 'image.inspect', inputAssets: [{ assetId: 'asset', assetVersionId: 'other-version' }], targetKind: 'tool', targetId: 'inspector', executionStatus: 'succeeded', deliveryStatus: 'saved', inspectionStatus: 'not_requested', createdAt: 2, updatedAt: 2 }
    const save = (record: FileOperationRecord) => db.prepare('INSERT OR REPLACE INTO file_operations (operation_id, owner_id, chat_id, request_id, fingerprint, data_json, request_json) VALUES (?, ?, ?, ?, ?, ?, ?)').run(record.operationId, 'inspection-owner', chatId, record.operationId, '', JSON.stringify(record), '{}')
    try {
      save(generated); save(evidence)
      expect(() => recordFileInspection(generated.operationId, evidence.operationId, true, '符合要求', 'inspection-owner', chatId)).toThrow('固定版本')
      evidence.inputAssets[0]!.assetVersionId = 'original'
      save(evidence)
      expect(() => recordFileInspection(generated.operationId, evidence.operationId, true, '符合要求', 'other-owner', chatId)).toThrow('无权访问')
      expect(recordFileInspection(generated.operationId, evidence.operationId, true, '符合要求', 'inspection-owner', chatId).inspectionStatus).toBe('passed')
      expect(recordFileInspection(generated.operationId, evidence.operationId, false, '缺少指定元素', 'inspection-owner', chatId).inspectionStatus).toBe('failed_inspection')
      evidence.executionStatus = 'failed'
      save(evidence)
      expect(recordFileInspection(generated.operationId, evidence.operationId, true, '不能读取文件', 'inspection-owner', chatId).inspectionStatus).toBe('inspection_error')
    } finally { deleteChat(chatId) }
  })
})
