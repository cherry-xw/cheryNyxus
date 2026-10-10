import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import type { HookEvent } from './types.js'
const object = z.record(z.string(), z.unknown())
const reason = z.string().max(500)
const decision = z.enum(['block', 'allow']).optional()
const readonlyEvents = new Set<HookEvent>([
  'SessionEnd',
  'PostToolUse',
  'ToolFailed',
  'Stop',
  'PostCompact',
  'RequestCompleted',
  'RequestFailed',
  'RequestCancelled',
  'ChannelSendResult',
])
export function isReadonlyHook(event: HookEvent): boolean {
  return readonlyEvents.has(event)
}
const schemas: Partial<Record<HookEvent, z.ZodType>> = {
  SessionStart: z.object({ additionalContext: z.string().optional() }).strict(),
  UserPromptSubmit: z
    .object({ decision, reason: reason.optional(), additionalContext: z.string().optional() })
    .strict(),
  RequestPrepare: z
    .object({
      decision,
      reason: reason.optional(),
      contexts: z
        .array(
          z
            .object({
              key: z.string().min(1).max(100),
              content: z.string(),
              configRevision: z.number().int().nonnegative(),
            })
            .strict(),
        )
        .optional(),
    })
    .strict(),
  PreLLMRequest: z
    .object({ decision, reason: reason.optional(), body: object.optional() })
    .strict(),
  PostLLMResponse: z.object({ decision, reason: reason.optional() }).strict(),
  PreToolUse: z
    .object({
      decision: z.enum(['allow', 'deny', 'ask']).optional(),
      reason: reason.optional(),
      updatedInput: object.optional(),
    })
    .strict(),
  PreCompact: z.object({ decision, reason: reason.optional() }).strict(),
}
const mutableParameters = new Set([
  'thinking',
  'reasoning',
  'reasoning_effort',
  'max_tokens',
  'max_output_tokens',
  'max_completion_tokens',
  'temperature',
  'top_p',
  'top_k',
  'stop',
  'stop_sequences',
])
export function validateDecision(
  event: HookEvent,
  value: unknown,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const schema = schemas[event] ?? z.object({}).strict()
  const result = schema.parse(value ?? {}) as Record<string, unknown>
  if (event === 'PreLLMRequest' && result.body) {
    const previous = payload.body as Record<string, unknown>
    const next = result.body as Record<string, unknown>
    for (const name of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (!mutableParameters.has(name) && !isDeepStrictEqual(previous[name], next[name]))
        throw new Error('HOOK_INVALID_OUTPUT')
      if (mutableParameters.has(name) && next[name] !== undefined) {
        const item = next[name]
        if (name.startsWith('max_') || name === 'top_k') {
          if (!Number.isSafeInteger(item) || Number(item) < (name === 'top_k' ? 0 : 1))
            throw new Error('HOOK_INVALID_OUTPUT')
        } else if (name === 'temperature' || name === 'top_p') {
          if (
            typeof item !== 'number' ||
            !Number.isFinite(item) ||
            item < 0 ||
            item > (name === 'top_p' ? 1 : 2)
          )
            throw new Error('HOOK_INVALID_OUTPUT')
        } else if (name === 'reasoning_effort') {
          if (typeof item !== 'string' || !item) throw new Error('HOOK_INVALID_OUTPUT')
        } else if (name === 'stop' || name === 'stop_sequences') {
          if (!(
            typeof item === 'string' ||
            (Array.isArray(item) && item.every((value) => typeof value === 'string'))
          ))
            throw new Error('HOOK_INVALID_OUTPUT')
        } else if (name === 'thinking' && (typeof item === 'boolean' || typeof item === 'string')) {
          // Ollama uses a boolean or an effort name; protocol validation follows.
        } else if (!item || typeof item !== 'object' || Array.isArray(item))
          throw new Error('HOOK_INVALID_OUTPUT')
      }
    }
  }
  return result
}
