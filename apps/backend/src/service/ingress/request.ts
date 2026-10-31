import { AsyncLocalStorage } from 'node:async_hooks'
import type { IngressRequestIdentity } from './api.js'

/** Internal host-to-runner handoff, never supplied by a public wire request. */
export const ingressExecution = new AsyncLocalStorage<{
  identity: Readonly<IngressRequestIdentity>
  signal?: AbortSignal
  execution?: { toolHistory: 'request'; retry: 'never' }
  sourceInput?: import('@chery/protocol').SourceInput
  sourceCapacity?: import('@chery/plugin-api').IngressSourceCapacity
  validate(): void
}>()
