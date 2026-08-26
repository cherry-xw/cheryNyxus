/**
 * Temporary event transport port used by controllers not yet expressed as use cases.
 * TODO(architecture): move these subscriptions into canonical owners/runtime and remove
 * this port (docs/architecture-issues.md TODO-A01).
 */
export { wsClient } from '@/services/ws'
