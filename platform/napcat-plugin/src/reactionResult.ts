const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}

/** 65002 means the same reaction is already set, not that a new visible action occurred. */
export function reactionResult(value: unknown): { alreadySet: boolean } {
  const envelope = object(value), data = 'data' in envelope ? object(envelope.data) : envelope
  const code = data.result
  if (envelope.status === 'failed' || envelope.retcode !== undefined && envelope.retcode !== 0 ||
    code === false || typeof code === 'number' && code !== 0 && code !== 65002) {
    throw Object.assign(new Error('Reaction rejected'), { definitelyFailed: true,
      ...(Number.isSafeInteger(envelope.retcode) ? { nativeRetcode: envelope.retcode } : {}),
      ...(Number.isSafeInteger(code) ? { nativeResult: code } : {}) })
  }
  return { alreadySet: code === 65002 }
}
