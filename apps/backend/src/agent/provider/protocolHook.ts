import { z } from 'zod'
import { isDeepStrictEqual } from 'node:util'
import type { LLMOptions } from '@/core/llm/adapter.js'
import { dispatch } from '@/agent/hooks/dispatch.js'
import { ClassifiedError } from '@/utils/error.js'
import { preflightModelInput } from './inputPreflight.js'

const count = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const stop = z.union([z.string(), z.array(z.string()).max(4)])
const effort = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const thinking = z.object({ type: z.enum(['enabled', 'disabled']) }).strict()
const parameters = {
  openai: {
    temperature: z.number().min(0).max(2),
    top_p: z.number().min(0).max(1),
    max_tokens: count,
    max_completion_tokens: count,
    stop,
    reasoning_effort: effort.exclude(['max']),
  },
  'openai-responses': {
    temperature: z.number().min(0).max(2),
    top_p: z.number().min(0).max(1),
    max_output_tokens: count,
    reasoning: z
      .object({
        effort: effort.exclude(['max']).optional(),
        summary: z.enum(['auto', 'concise', 'detailed']).nullable().optional(),
      })
      .strict(),
  },
  deepseek: {
    temperature: z.number().min(0).max(2),
    top_p: z.number().min(0).max(1),
    max_tokens: count.max(65536),
    stop,
    thinking,
    reasoning_effort: z.enum(['high', 'max']),
  },
  bigmodel: {
    temperature: z.number().min(0).max(1),
    top_p: z.number().min(0.01).max(1),
    max_tokens: count.max(131072),
    stop: z.array(z.string()).max(4),
    thinking: z
      .object({ type: z.enum(['enabled', 'disabled']), clear_thinking: z.boolean().optional() })
      .strict(),
    reasoning_effort: effort,
  },
  anthropic: {
    temperature: z.number().min(0).max(1),
    top_p: z.number().min(0).max(1),
    top_k: z.number().int().nonnegative(),
    max_tokens: count,
    stop_sequences: z.array(z.string()),
    thinking: z.discriminatedUnion('type', [
      z.object({ type: z.literal('enabled'), budget_tokens: count.min(1024) }).strict(),
      z.object({ type: z.literal('disabled') }).strict(),
      z.object({ type: z.literal('adaptive') }).strict(),
    ]),
  },
  ollama: {
    // Hooks use the shared public names; the adapter places them in Ollama options.
    temperature: z.number().nonnegative(),
    top_p: z.number().min(0).max(1),
    top_k: z.number().int().nonnegative(),
    max_tokens: count,
    stop: z.array(z.string()),
    thinking: z.union([z.boolean(), z.enum(['low', 'medium', 'high'])]),
  },
} satisfies Record<string, Record<string, z.ZodType>>

export type HookProtocol = keyof typeof parameters

/** Validate only changes: existing model-catalog/vendor parameters remain untouched. */
export function validateProtocolParameters(
  original: Record<string, unknown>,
  candidate: Record<string, unknown>,
  protocol: HookProtocol,
): void {
  const supported: Record<string, z.ZodType> = parameters[protocol]
  for (const key of new Set([...Object.keys(original), ...Object.keys(candidate)])) {
    if (isDeepStrictEqual(original[key], candidate[key])) continue
    const schema = supported[key]
    if (!schema || (candidate[key] !== undefined && !schema.safeParse(candidate[key]).success))
      throw invalidParameter()
  }
  if (
    protocol === 'anthropic' &&
    (!isDeepStrictEqual(original.thinking, candidate.thinking) ||
      !isDeepStrictEqual(original.max_tokens, candidate.max_tokens))
  ) {
    const value = candidate.thinking as { type?: string; budget_tokens?: number } | undefined
    if (value?.type === 'enabled' && Number(value.budget_tokens) >= Number(candidate.max_tokens))
      throw invalidParameter()
  }
}
function invalidParameter() {
  return new ClassifiedError({
    message: 'HOOK_INVALID_PROTOCOL_PARAMETER',
    userMessage: '模型请求参数无效',
    category: 'validation',
    source: 'hook',
  })
}

export async function applyProtocolHook<T extends Record<string, unknown>>(
  body: T,
  options?: LLMOptions,
  protocol: HookProtocol = resolveHookProtocol(options),
): Promise<T> {
  if (options?.skipHooks) return body
  const original = structuredClone(body)
  const payload = {
    provider: options?.provider ?? protocol,
    model: options?.model ?? String(body.model ?? ''),
    url: options?.url ?? '',
    thinking: options?.thinking,
    stream: body.stream === true,
    body,
  }
  await dispatch('PreLLMRequest', payload, {
    brain: options?.brain ?? '',
    chatId: options?.chatId,
    requestId: options?.requestView?.requestId,
    inputId: options?.requestView?.inputId,
    requestView: options?.requestView,
    signal: options?.signal,
  })
  validateProtocolParameters(original, payload.body, protocol)
  await preflightModelInput(payload.body, options, protocol)
  return payload.body as T
}

function resolveHookProtocol(options?: LLMOptions): HookProtocol {
  if (options?.protocol === 'anthropic-messages') return 'anthropic'
  if (options?.protocol === 'ollama-chat') return 'ollama'
  if (options?.protocol === 'openai-responses') return 'openai-responses'
  if (options?.provider === 'deepseek' || options?.provider === 'bigmodel') return options.provider
  return 'openai'
}
