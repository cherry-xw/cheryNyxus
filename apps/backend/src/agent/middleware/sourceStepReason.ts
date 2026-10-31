import type { MiddlewareContext } from '@/core/middleware/types.js'

/** Execution provenance, never inferred from shared conversation contents. */
export function sourceStepReason(ctx: MiddlewareContext, turn: number): 'initial' | 'tool_continue' | 'question_resume' {
  return turn > 0 ? 'tool_continue' : ctx.requestExecution?.sourceStartReason ?? 'initial'
}
