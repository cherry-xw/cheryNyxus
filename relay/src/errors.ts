import type { RelayErrorBody, RelayErrorCode } from '@chery/protocol/relay'

const STATUS_BY_CODE: Record<RelayErrorCode, number> = {
  INVALID_REQUEST: 400,
  BACKEND_AUTH_FAILED: 401,
  SESSION_BACKEND_MISMATCH: 403,
  BACKEND_NOT_FOUND: 404,
  BACKEND_ID_CONFLICT: 409,
  BACKEND_OFFLINE: 410,
  REQUEST_TOO_LARGE: 413,
  PROTOCOL_VERSION_UNSUPPORTED: 426,
  RATE_LIMITED: 429,
  CAPACITY_EXCEEDED: 429,
  BACKEND_UNAVAILABLE: 502,
  BACKEND_TIMEOUT: 504,
}

export class RelayError extends Error {
  readonly status: number

  constructor(
    readonly code: RelayErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message)
    this.name = 'RelayError'
    this.status = STATUS_BY_CODE[code]
  }
}

export function relayErrorBody(error: RelayError, requestId: string): RelayErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      requestId,
      ...(error.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: error.retryAfterSeconds }),
    },
  }
}

export function asRelayError(error: unknown): RelayError {
  if (error instanceof RelayError) return error
  return new RelayError('BACKEND_UNAVAILABLE', 'Backend is temporarily unavailable')
}
