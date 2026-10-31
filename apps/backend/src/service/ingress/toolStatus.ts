import { SupervisionLevel } from '@/core/config.js'
import { getSense, getSenseOrigin } from '@/core/sense/senseRegistry.js'
import { authorizeToolCall, type CompiledRoleSecurity } from '@/core/security/rolePolicy.js'
import type { IngressPreset } from './api.js'

export function ingressToolStatus(tools: readonly string[], security: CompiledRoleSecurity, defaultLevel: SupervisionLevel): NonNullable<IngressPreset['toolStatus']> {
  const selections = new Map<string, { base: string; level: SupervisionLevel; available: boolean }>()
  for (const entry of tools) {
    const [selection = '', configured] = entry.split(':').map(value => value.trim()), base = selection.split('.')[0]!
    const sense = getSense(base)
    const declared = sense?.operationPolicy?.keys
    const valid = !!sense && (selection === base || !!declared?.includes(selection))
    const level = Math.max(configured === 'auto' ? SupervisionLevel.auto : configured === 'manual' ? SupervisionLevel.manual : configured === 'smart' ? SupervisionLevel.smart : defaultLevel, sense?.supervisionLevel ?? 0) as SupervisionLevel
    const available = valid && getSenseOrigin(base)?.available?.() !== false
    for (const key of selection === base && declared ? declared : [selection]) {
      const prior = selections.get(key)
      selections.set(key, { base, level: Math.max(prior?.level ?? 0, level) as SupervisionLevel, available })
    }
  }
  return [...selections].map(([selection, item]) => {
    const decision = authorizeToolCall({ security, name: item.base, args: {}, configuredLevel: item.level,
      ...(selection !== item.base ? { operation: { key: selection, allowed: item.available } } : {}) }).decision
    return { selection, available: item.available, allowed: item.available && decision === 'allow',
      reason: !item.available ? 'tool_unavailable' : decision !== 'allow' ? `role_${decision}` : undefined }
  })
}
