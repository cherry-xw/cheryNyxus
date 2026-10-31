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

export const EntryFailurePhaseSchema = z.enum(['preparation', 'source_context', 'source_files', 'core_submit'])
export type EntryFailurePhase = z.infer<typeof EntryFailurePhaseSchema>
const EntryFailureCodeSchema = z.enum(['EXECUTION_ENTRY_FAILED', 'PREVIOUS_WORK_PENDING', 'BACKEND_RESUME_REQUIRED',
  'IDENTITY_REJECTED', 'SOURCE_CONTEXT_UNAVAILABLE', 'PERMISSION_DENIED', 'AUTH_REQUIRED', 'SOURCE_CONFLICT',
  'REVISION_CONFLICT', 'NOT_FOUND', 'FILE_TOO_LARGE', 'FILE_INVALID', 'ENOENT', 'EACCES', 'ENOSPC', 'EIO',
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'])
export const EntryFailureSchema = z.object({ code: EntryFailureCodeSchema, phase: EntryFailurePhaseSchema, occurredAt: z.number().finite() }).strict()

/** Unknown codes and all error prose are discarded, including nested causes. */
export function entryFailure(error: unknown, phase: EntryFailurePhase): z.infer<typeof EntryFailureSchema> {
  const parsed = EntryFailureCodeSchema.safeParse(typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined)
  return { code: parsed.success ? parsed.data : 'EXECUTION_ENTRY_FAILED', phase, occurredAt: Date.now() }
}

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
