import { getSoulDb } from './index.js'
import type { ServerToolObservation } from '@chery/protocol'

export function saveServerToolObservations(scopeId: string, observations: ServerToolObservation[]): void {
  const db = getSoulDb()
  const write = db.prepare(`
    INSERT INTO server_tool_observations (scope_id, tool_name, status, observed_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(scope_id, tool_name) DO UPDATE SET
      status = excluded.status, observed_at = excluded.observed_at
    WHERE excluded.observed_at >= server_tool_observations.observed_at
  `)
  db.transaction(() => {
    for (const observation of observations) {
      if (!/^[a-zA-Z0-9_.:/-]{1,128}$/.test(observation.name)) continue
      write.run(scopeId, observation.name, observation.status, observation.observedAt)
    }
  })()
}

export function listServerToolObservations(scopeId: string): {
  tools: ServerToolObservation[]
  truncated: boolean
} {
  const rows = getSoulDb().prepare(`
    SELECT tool_name AS name, status, observed_at AS observedAt
    FROM server_tool_observations WHERE scope_id = ?
    ORDER BY observed_at DESC, tool_name LIMIT 201
  `).all(scopeId) as ServerToolObservation[]
  return { tools: rows.slice(0, 200), truncated: rows.length > 200 }
}
