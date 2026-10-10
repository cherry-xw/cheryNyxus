import { getSoulDb } from './index.js'

export interface TaskResultViewRow {
  taskKey: string
  resultId: string
  viewedAt: number
}

export function getTaskResultView(taskKey: string): TaskResultViewRow | undefined {
  const row = getSoulDb()
    .prepare('SELECT task_key, result_id, viewed_at FROM task_result_views WHERE task_key = ?')
    .get(taskKey) as { task_key: string; result_id: string; viewed_at: number } | undefined
  return row
    ? { taskKey: row.task_key, resultId: row.result_id, viewedAt: row.viewed_at }
    : undefined
}

export function setTaskResultView(taskKey: string, resultId: string, viewedAt: number): void {
  getSoulDb()
    .prepare(
      `INSERT INTO task_result_views (task_key, result_id, viewed_at) VALUES (?, ?, ?)
       ON CONFLICT(task_key) DO UPDATE SET result_id=excluded.result_id, viewed_at=excluded.viewed_at`,
    )
    .run(taskKey, resultId, viewedAt)
}
