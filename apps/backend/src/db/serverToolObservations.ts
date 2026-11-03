import { getSoulDb } from './index.js'
import type {
  ServerToolCapability,
  ServerToolObservation,
  ServerToolVerificationRecord,
} from '@chery/protocol'
import type { ServerToolCallInfo } from '@/core/message/adapter.js'

const VALID_TOOL_NAME = /^[a-zA-Z0-9_.:/-]{1,128}$/

function sanitizeReason(reason?: string): string | undefined {
  if (!reason) return undefined
  const cleaned = reason
    .replace(/https?:\/\/\S+/gi, '[URL]')
    .replace(/(?:sk|key|token|sig|signature)[-_a-z0-9]*=[a-z0-9._~-]+/gi, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? cleaned.slice(0, 120) : undefined
}

export function inferServerToolCapability(
  toolName: string,
  rawArguments?: string,
): ServerToolCapability | undefined {
  if (toolName === 'analyze_image' || toolName === 'image_analysis') return 'imageInspect'
  if (toolName === 'webReader' || toolName === 'open_page') return 'webReader'
  if (toolName === 'web_search_call' && rawArguments) {
    try {
      const parsed = JSON.parse(rawArguments) as { type?: string; action?: string }
      if (parsed.type === 'open_page' || parsed.action === 'open_page') return 'webReader'
    } catch {
      // ignore invalid json
    }
  }
  if (
    toolName === 'web_search_prime' ||
    toolName === 'webSearchPrime' ||
    toolName === 'web_search' ||
    toolName === 'web_search_call'
  ) {
    return 'webSearch'
  }
  return undefined
}

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
      if (!VALID_TOOL_NAME.test(observation.name)) continue
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

export function saveServerToolVerifications(
  scopeId: string,
  verifications: ServerToolVerificationRecord[],
): void {
  const db = getSoulDb()
  const write = db.prepare(`
    INSERT INTO server_tool_verifications (scope_id, tool_name, capability, status, verified_at, reason)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(scope_id, tool_name) DO UPDATE SET
      capability = COALESCE(excluded.capability, server_tool_verifications.capability),
      status = excluded.status,
      verified_at = excluded.verified_at,
      reason = excluded.reason
    WHERE excluded.verified_at >= server_tool_verifications.verified_at
  `)
  db.transaction(() => {
    for (const item of verifications) {
      if (!VALID_TOOL_NAME.test(item.name)) continue
      write.run(
        scopeId,
        item.name,
        item.capability ?? inferServerToolCapability(item.name) ?? null,
        item.status,
        item.verifiedAt,
        sanitizeReason(item.reason) ?? null,
      )
    }
  })()
}

export function listServerToolVerifications(scopeId: string): ServerToolVerificationRecord[] {
  const rows = getSoulDb().prepare(`
    SELECT
      tool_name AS name,
      capability,
      status,
      verified_at AS verifiedAt,
      reason
    FROM server_tool_verifications
    WHERE scope_id = ?
    ORDER BY verified_at DESC, tool_name LIMIT 200
  `).all(scopeId) as Array<{
    name: string
    capability: ServerToolCapability | null
    status: 'verified' | 'failed'
    verifiedAt: number
    reason: string | null
  }>
  return rows.map((row) => ({
    name: row.name,
    ...(row.capability ? { capability: row.capability } : {}),
    status: row.status,
    verifiedAt: row.verifiedAt,
    ...(row.reason ? { reason: row.reason } : {}),
  }))
}

export function clearServerToolVerifications(scopeId: string, toolName?: string): void {
  const db = getSoulDb()
  if (toolName) {
    db.prepare('DELETE FROM server_tool_verifications WHERE scope_id = ? AND tool_name = ?').run(
      scopeId,
      toolName,
    )
    return
  }
  db.prepare('DELETE FROM server_tool_verifications WHERE scope_id = ?').run(scopeId)
}

/**
 * Evaluate and persist real task verification outcome for a completed turn.
 * Unlike raw event observation, a tool call is marked 'verified' only when:
 * 1. The turn finished normally (end_turn / stop / completed) with a non-empty final answer;
 * 2. The server tool call completed without error or fetch failure;
 * 3. The tool produced non-empty verifiable output or sources.
 */
export function recordServerToolTaskVerification(
  scopeId: string | undefined,
  input: {
    calls: ServerToolCallInfo[]
    finalContent?: string
    stopReason?: string
    verifiedAt?: number
  },
): ServerToolVerificationRecord[] {
  if (!scopeId || !input.calls.length) return []
  const verifiedAt = input.verifiedAt ?? Date.now()
  const finalContent = input.finalContent?.trim() ?? ''
  const normalStop =
    input.stopReason === 'end_turn' ||
    input.stopReason === 'stop' ||
    input.stopReason === 'completed'
  const contentFetchFailed = /Failed to fetch\b|网页抓取失败|内容抓取失败/i.test(finalContent)
  const records: ServerToolVerificationRecord[] = []

  for (const call of input.calls) {
    if (call.status === 'skipped-local' || !VALID_TOOL_NAME.test(call.name)) continue
    const capability = inferServerToolCapability(call.name, call.arguments)
    // OpenAI Responses uses `web_search_call` for both search and open_page; internal open_page
    // events do not embed page body text in the tool item itself, so do not overwrite or fail
    // `web_search_call` when an `open_page` step lacks `result` text unless fetch explicitly failed.
    if (
      call.name === 'web_search_call' &&
      capability === 'webReader' &&
      call.status === 'completed' &&
      !call.error &&
      !contentFetchFailed &&
      !/Failed to fetch\b/i.test(call.result ?? '')
    ) {
      continue
    }
    const hasSources = Array.isArray(call.sources) && call.sources.length > 0
    const resultText = call.result?.trim() ?? ''
    const resultFetchFailed = /Failed to fetch\b/i.test(resultText)

    if (call.status === 'failed' || call.error) {
      records.push({
        name: call.name,
        ...(capability ? { capability } : {}),
        status: 'failed',
        verifiedAt,
        reason: sanitizeReason(call.error) ?? '服务端工具执行失败',
      })
      continue
    }

    if (call.status !== 'completed') continue

    if (contentFetchFailed || resultFetchFailed) {
      records.push({
        name: call.name,
        ...(capability ? { capability } : {}),
        status: 'failed',
        verifiedAt,
        reason: '调用已结束，但目标内容抓取失败',
      })
      continue
    }

    const hasEvidence =
      capability === 'webSearch'
        ? hasSources || Boolean(resultText)
        : capability === 'webReader'
          ? Boolean(resultText)
          : Boolean(resultText) || hasSources

    if (!normalStop) {
      // Intermediate turn (e.g., tool_use continuation); do not prematurely mark verified.
      continue
    }

    if (!hasEvidence || !finalContent) {
      records.push({
        name: call.name,
        ...(capability ? { capability } : {}),
        status: 'failed',
        verifiedAt,
        reason: !hasEvidence ? '调用已结束，但未返回可核对的结果或来源' : '未生成有效最终回答',
      })
      continue
    }

    records.push({
      name: call.name,
      ...(capability ? { capability } : {}),
      status: 'verified',
      verifiedAt,
    })
  }

  if (records.length > 0) {
    saveServerToolVerifications(scopeId, records)
  }
  return records
}
