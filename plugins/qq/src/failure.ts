import { z } from 'zod'
import { ErrorId, publicOutcomeText } from '@chery/protocol'

export const FailureSchema = z.object({
  runId: z.string().max(200), code: z.string().max(100).optional(),
  tracingId: z.string().regex(/^[0-9a-f]{8}$/).optional(),
  retryable: z.boolean().optional(), occurredAt: z.number().finite(),
  stage: z.enum(['model', 'execution']), text: z.string().max(2000),
  inputImageReferences: z.number().int().nonnegative(),
})
export type Failure = z.infer<typeof FailureSchema>

/** Only declared codes and registry prose survive; never copy provider/error prose. */
export function mergeFailure(previous: Failure | undefined, runId: string, data: Record<string, unknown>, imageReferences: number): Failure {
  const feedback = data.feedback as {code?: unknown; tracingId?: unknown} | undefined
  const candidate = feedback?.code ?? data.code
  const code = typeof candidate === 'string' && Object.values(ErrorId).includes(candidate as typeof ErrorId[keyof typeof ErrorId]) ? candidate : undefined
  const trace = feedback?.tracingId ?? data.tracingId
  const tracingId = typeof trace === 'string' && /^[0-9a-f]{8}$/.test(trace) ? trace : previous?.tracingId
  const selected = previous?.code ?? code
  const retryable = typeof data.retryable === 'boolean' ? data.retryable : previous?.retryable
  return { runId, ...(selected ? {code:selected} : {}), ...(tracingId ? {tracingId} : {}),
    ...(retryable !== undefined ? {retryable} : {}), occurredAt: previous?.occurredAt ?? Date.now(),
    stage: selected?.startsWith('BRAIN_') ? 'model' : 'execution', inputImageReferences: imageReferences,
    text: publicOutcomeText({status:'failed', retryable, feedback:{code:selected,tracingId}}),
  }
}
