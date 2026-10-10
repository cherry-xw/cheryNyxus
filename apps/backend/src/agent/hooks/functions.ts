import type {
  IngressHookRegistration,
  HookEvent,
  HookDispatchContext,
  HookPayloadMap,
} from './types.js'
import { immutableSnapshot } from '@/service/ingress/api.js'

interface Registration {
  ownerId: string
  order: number
  sequence: number
  channels: readonly string[]
  signal: AbortSignal
  definition: IngressHookRegistration
}
const handlers: Registration[] = []
let sequence = 0
export function registerFunctionHook(
  ownerId: string,
  order: number,
  channels: readonly string[],
  signal: AbortSignal,
  definition: IngressHookRegistration,
): () => void {
  if (
    !Number.isInteger(definition.priority ?? 0) ||
    Math.abs(definition.priority ?? 0) > 1000 ||
    !Number.isInteger(definition.timeoutMs ?? 10000) ||
    (definition.timeoutMs ?? 10000) < 1 ||
    (definition.timeoutMs ?? 10000) > 30000 ||
    typeof definition.handler !== 'function'
  )
    throw Object.assign(new Error('INVALID_PARAMS'), { code: 'INVALID_PARAMS' })
  const entry = { ownerId, order, channels, signal, definition, sequence: sequence++ }
  handlers.push(entry)
  return () => {
    const index = handlers.indexOf(entry)
    if (index !== -1) handlers.splice(index, 1)
  }
}
export function functionHooks(event: HookEvent) {
  return handlers
    .filter((item) => item.definition.event === event && !item.signal.aborted)
    .sort(
      (a, b) =>
        a.order - b.order ||
        a.ownerId.localeCompare(b.ownerId) ||
        (a.definition.priority ?? 0) - (b.definition.priority ?? 0) ||
        a.sequence - b.sequence,
    )
}
export function projectHookContext(
  ctx: HookDispatchContext,
  channels: readonly string[] = [],
): HookDispatchContext {
  const view = ctx.requestView
  if (!view) return { ...ctx }
  const identity = { ...view.identity }
  if (!identity.channel || !channels.includes(identity.channel)) delete identity.subject
  return { ...ctx, requestView: immutableSnapshot({ ...view, identity }) }
}
export async function invokeFunction(
  entry: Registration,
  payload: HookPayloadMap[HookEvent],
  ctx: HookDispatchContext,
  signal: AbortSignal,
): Promise<unknown> {
  return entry.definition.handler(immutableSnapshot(payload), {
    ...projectHookContext(ctx, entry.channels),
    signal,
  })
}
