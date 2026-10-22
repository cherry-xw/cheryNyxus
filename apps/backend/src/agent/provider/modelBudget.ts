import { ClassifiedError } from '@/utils/error.js'
import { ErrorId } from '@chery/protocol'
import { measureModelInput } from './inputBudget.js'

/** Internal control signal before transport. Never classified as a provider rejection. */
export class ModelInputNeedsCompaction extends ClassifiedError {
  constructor() { super({ errorId: ErrorId.REQUEST_INPUT_TOO_LARGE, message: 'Prepared model input needs compaction', userMessage: '本次输入需要整理历史后才能继续。', category: 'validation', source: 'chat' }); this.name = 'ModelInputNeedsCompaction' }
}

export function outputReserve(body: Record<string, unknown>): number {
  for (const value of [body.max_output_tokens, body.max_completion_tokens, body.max_tokens, (body.options as Record<string, unknown> | undefined)?.num_predict]) {
    if (Number.isSafeInteger(value) && Number(value) > 0) return Number(value)
  }
  return 0
}

export function modelBudget(body: Record<string, unknown>, contextLimit: number | undefined, safetyMargin = 0) {
  const measurement = measureModelInput(body)
  const reserve = outputReserve(body)
  return { ...measurement, outputReserve: reserve, safetyMargin, effectiveCeiling: contextLimit ? Math.max(0, contextLimit - reserve - safetyMargin) : undefined }
}
