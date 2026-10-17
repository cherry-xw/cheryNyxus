import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { FileOperationRecord, MessagePart } from '@chery/protocol'
import { collectTaskOutputs, defaultDeliverableAssetIds, getSpawnInputParts, setSpawnInputParts,
  getSpawnTaskResult, saveSpawnTaskResult, getSpawnDeliverableSelection, saveSpawnDeliverableSelection } from '@/db/fileDeliverables.js'

let db: Database.Database
const messages = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }))
vi.mock('@/db/index.js', () => ({ getSoulDb: () => db }))
vi.mock('@/db/message.js', () => ({ getMessages: () => messages.rows, parseMessageRow: (row: unknown) => row }))

const asset = (id: string): MessagePart => ({ type: 'asset', partId: `part:${id}`, assetId: id,
  assetVersionId: `version:${id}`, variant: 'original', usage: 'content' })
const operation = (id: string, outputs: string[], inputs: string[] = [], time = 1): FileOperationRecord => ({
  operationId: id, operation: inputs.length ? 'image.edit' : 'image.generate',
  inputAssets: inputs.map((assetId) => ({ assetId, assetVersionId: `version:${assetId}` })),
  targetKind: 'tool', targetId: 'test', executionStatus: 'succeeded', deliveryStatus: 'saved',
  inspectionStatus: 'not_requested', outputAssetIds: outputs, outputParts: outputs.map(asset),
  createdAt: time, updatedAt: time,
})

beforeEach(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE spawn_tasks (task_id TEXT PRIMARY KEY); INSERT INTO spawn_tasks VALUES (\'task\')')
  messages.rows = []
})
afterEach(() => db.close())

describe('formal file deliverables', () => {
  it('keeps every image in the last successful batch of each independent chain', () => {
    expect(defaultDeliverableAssetIds([
      operation('first', ['draft-a', 'draft-b']), operation('independent', ['other-a', 'other-b']),
      operation('edit', ['final-a', 'final-b'], ['draft-a'], 2),
    ])).toEqual(['other-a', 'other-b', 'final-a', 'final-b'])
  })

  it('a failed edit does not replace an earlier saved result', () => {
    const failed = { ...operation('failed', [], ['draft'], 2), executionStatus: 'failed' as const }
    expect(defaultDeliverableAssetIds([operation('draft', ['draft']), failed])).toEqual(['draft'])
  })

  it('combines chains when an edit explicitly uses outputs from both', () => {
    expect(defaultDeliverableAssetIds([operation('one', ['a']), operation('two', ['b']),
      operation('merge', ['combined-1', 'combined-2'], ['a', 'b'], 2)])).toEqual(['combined-1', 'combined-2'])
  })

  it('persists fixed input parts and explicit empty selection', () => {
    setSpawnInputParts('task', [asset('input')])
    expect(getSpawnInputParts('task')).toEqual([asset('input')])
    expect(getSpawnDeliverableSelection('task')).toBeUndefined()
    saveSpawnDeliverableSelection('task', [])
    expect(getSpawnDeliverableSelection('task')).toEqual([])
  })

  it('completion is first-write-wins and prevents later result selection', () => {
    const result = { summaryParts: [asset('output')], deliverableAssetIds: ['output'],
      operationIds: ['operation'], status: 'completed' as const, selection: 'system' as const }
    saveSpawnTaskResult('task', result)
    expect(saveSpawnTaskResult('task', { ...result, deliverableAssetIds: [] })).toEqual(result)
    expect(getSpawnTaskResult('task')).toEqual(result)
    expect(() => saveSpawnDeliverableSelection('task', ['other'])).toThrow('任务已完成')
  })

  it('collects all operation and message outputs, but not user inputs or URLs', () => {
    messages.rows = [
      { role: 'user', parts: [asset('input')] },
      { role: 'sense', parts: [], fileOperations: [operation('first', ['draft'])] },
      { role: 'assistant', parts: [asset('native')], content: 'https://example.invalid/image.png' },
      { role: 'assistant', parts: [], content: 'Done' },
    ]
    const outputs = collectTaskOutputs('child')
    expect(outputs.defaultAssetIds).toEqual(['draft', 'native'])
    expect(outputs.assets.map((part) => part.assetId)).toEqual(['native', 'draft'])
    expect(outputs.operations.map((op) => op.operationId)).toEqual(['first'])
  })
})
