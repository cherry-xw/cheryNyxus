import { getSoulDb } from './index.js'
import type { ModelRequestEvent } from '@/core/llm/usage.js'

export interface StoredRequestUsage extends ModelRequestEvent {
  taskKey: string
  runId?: string
  branchId?: string
}
export interface StoredUsageOperation {
  id: string
  taskKey: string
  chatId: string
  attemptId?: string
  toolName: string
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'rejected' | 'interrupted'
}

export function saveRequestUsage(record: StoredRequestUsage): void {
  getSoulDb()
    .prepare(
      `INSERT INTO model_request_usage
    (attempt_id,task_key,chat_id,run_id,input_message_id,started_at,ended_at,data_json)
    VALUES (@attemptId,@taskKey,@chatId,@runId,@inputMessageId,@startedAt,@endedAt,@data)
    ON CONFLICT(attempt_id) DO UPDATE SET
      ended_at=COALESCE(excluded.ended_at,model_request_usage.ended_at),
      data_json=excluded.data_json
    `,
    )
    .run({
      ...record,
      runId: record.runId ?? null,
      inputMessageId: record.inputMessageId ?? null,
      endedAt: record.endedAt ?? null,
      data: JSON.stringify(record),
    })
}

export function readRequestUsage(taskKey: string): StoredRequestUsage[] {
  return (
    getSoulDb()
      .prepare(
        'SELECT data_json FROM model_request_usage WHERE task_key=? ORDER BY started_at,attempt_id',
      )
      .all(taskKey) as { data_json: string }[]
  ).map((row) => JSON.parse(row.data_json) as StoredRequestUsage)
}

function page<T extends { attemptId?: string; id?: string }>(
  items: T[],
  cursor: string | undefined,
  limit = 30,
): { items: T[]; nextCursor?: string } {
  const size = Math.min(100, Math.max(1, limit))
  const start = cursor ? Math.max(0, Number.parseInt(cursor, 10) + 1) : 0
  const selected = items.slice(start, start + size)
  return {
    items: selected,
    ...(start + size < items.length ? { nextCursor: String(start + size - 1) } : {}),
  }
}

export function readRequestUsagePage(taskKey: string, cursor?: string, limit?: number) {
  return page(readRequestUsage(taskKey), cursor, limit)
}

export function saveUsageOperation(record: StoredUsageOperation): void {
  getSoulDb()
    .prepare(
      `INSERT INTO usage_operations
    (operation_id,task_key,chat_id,attempt_id,started_at,data_json)
    VALUES (@id,@taskKey,@chatId,@attemptId,@startedAt,@data)
    ON CONFLICT(operation_id) DO UPDATE SET data_json=excluded.data_json`,
    )
    .run({
      ...record,
      attemptId: record.attemptId ?? null,
      data: JSON.stringify(record),
    })
}

export function readUsageOperations(taskKey: string): StoredUsageOperation[] {
  return (
    getSoulDb()
      .prepare(
        'SELECT data_json FROM usage_operations WHERE task_key=? ORDER BY started_at,operation_id',
      )
      .all(taskKey) as { data_json: string }[]
  ).map((row) => JSON.parse(row.data_json) as StoredUsageOperation)
}

export function readUsageOperationsPage(taskKey: string, cursor?: string, limit?: number) {
  return page(readUsageOperations(taskKey), cursor, limit)
}
