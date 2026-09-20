import { randomUUID } from 'node:crypto'
import {
  reportModelRequest,
  type ModelRequestEvent,
  type RequestObservation,
} from '@/core/llm/usage.js'
import { extractModelUsage } from './usage.js'

export function createRequestObservation(
  identity: Omit<ModelRequestEvent, 'attemptId' | 'startedAt' | 'endedAt' | 'status' | 'usage'>,
): RequestObservation {
  let current: ModelRequestEvent | undefined
  const publish = () => {
    if (current) reportModelRequest({ ...current, usage: { ...current.usage } })
  }
  return {
    start(model) {
      if (current?.status === 'running') {
        current.status = 'failed'
        current.endedAt = Date.now()
        publish()
      }
      current = {
        ...identity,
        model: model ?? identity.model,
        attemptId: randomUUID(),
        startedAt: Date.now(),
        status: 'running',
        usage: {},
      }
      publish()
    },
    response(raw) {
      if (!current) return
      const usage = extractModelUsage(identity.protocol, raw, current.usage)
      if (JSON.stringify(usage) === JSON.stringify(current.usage)) return
      current.usage = usage
      publish()
    },
    finish(status) {
      if (!current || current.status !== 'running') return
      current.status = status
      current.endedAt = Date.now()
      publish()
    },
  }
}

/** SDK retries call fetch again; each transport attempt receives its own identity. */
export function observedFetch(observation?: RequestObservation): typeof fetch {
  return async (input, init) => {
    observation?.start()
    try {
      const response = await fetch(input, init)
      if (observation && response.ok) {
        // SDK adapters consume the original body. Inspect a clone so usage-only
        // terminal frames are still recorded without changing the response stream.
        void response
          .clone()
          .text()
          .then((body) => {
            const contentType = response.headers.get('content-type') ?? ''
            if (contentType.includes('text/event-stream')) {
              for (const line of body.split(/\r?\n/)) {
                const value = line.replace(/^data:\s*/, '').trim()
                if (!value || value === '[DONE]') continue
                try {
                  observation.response(JSON.parse(value))
                } catch {
                  /* adapter validates the source stream */
                }
              }
            } else {
              try {
                observation.response(JSON.parse(body))
              } catch {
                /* non-JSON responses are handled by the adapter */
              }
            }
          })
          .catch(() => undefined)
      }
      if (!response.ok) observation?.finish('failed')
      return response
    } catch (error) {
      observation?.finish(init?.signal?.aborted ? 'cancelled' : 'failed')
      throw error
    }
  }
}
