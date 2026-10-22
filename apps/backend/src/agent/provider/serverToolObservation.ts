import type { MessageProviderAdapterConfig, ServerToolCallDelta } from '@/core/message/adapter.js'
import type { RequestObservation } from '@/core/llm/usage.js'
import type { ServerToolObservation } from '@chery/protocol'
import { saveServerToolObservations } from '@/db/serverToolObservations.js'
import { logger, LogLevel } from '@/utils/logger/index.js'

/** Collect names/status only; never store arguments, responses, private blocks or credentials. */
export function observeServerTools(
  parent: RequestObservation,
  scopeId: string | undefined,
  adapter: MessageProviderAdapterConfig,
  stream: boolean,
  model: string,
): RequestObservation {
  if (!scopeId) return parent
  const calls = new Map<string, { name: string; status: ServerToolObservation['status'] }>()
  let started = false
  const flush = () => {
    if (!started || !calls.size) return
    const observedAt = Date.now()
    try {
      saveServerToolObservations(scopeId, [...calls.values()].map(call => ({
        ...call, status: call.status === 'started' ? 'unknown' : call.status, observedAt,
      })))
    } catch {
      logger.event('llm.server_tool_observation.unavailable', {}, LogLevel.warn)
    }
    calls.clear()
  }
  const ingest = (delta: ServerToolCallDelta) => {
    if (delta.kind === 'start') {
      const previous = calls.get(delta.id)
      calls.set(delta.id, {
        name: delta.name,
        status: previous?.status ?? (delta.status === 'skipped-local' ? 'unknown' : delta.status ?? 'started'),
      })
    } else if (delta.kind === 'result') {
      const previous = calls.get(delta.callId)
      // An orphan result does not prove a call started, nor its execution succeeded.
      if (previous) previous.status = delta.status === 'skipped-local' ? 'unknown' : delta.status ?? 'unknown'
      else if (delta.name) calls.set(delta.callId, { name: delta.name, status: 'unknown' })
    }
  }
  return {
    start(actualModel) {
      flush()
      calls.clear()
      started = !actualModel || actualModel === model
      parent.start(actualModel)
    },
    response(raw) {
      parent.response(raw)
      if (!started) return
      try {
        if (stream) {
          for (const delta of adapter.extractStreamServerToolDeltas?.(raw) ?? []) ingest(delta)
        } else {
          for (const call of adapter.serverToolCalls?.(raw) ?? []) {
            if (call.status !== 'skipped-local') calls.set(call.id, { name: call.name, status: call.status })
          }
        }
      } catch {
        logger.event('llm.server_tool_observation.parse_failed', {}, LogLevel.warn)
      }
    },
    finish(status) {
      flush()
      started = false
      parent.finish(status)
    },
  }
}
