export interface MaintenanceState {
  active: boolean
  reason?: string
  details?: string[]
  since?: number
}

let state: MaintenanceState = process.env.CHERY_MAINTENANCE_REASON
  ? {
      active: true,
      reason: process.env.CHERY_MAINTENANCE_REASON,
      details: ['请在设置中修复配置，或显式保存当前回退版本。'],
      since: Date.now(),
    }
  : { active: false }

export function getMaintenanceState(): MaintenanceState {
  return { ...state, ...(state.details ? { details: [...state.details] } : {}) }
}

export function enterMaintenanceMode(reason: string, details: string[] = []): MaintenanceState {
  state = { active: true, reason, details, since: state.since ?? Date.now() }
  return getMaintenanceState()
}

export function leaveMaintenanceMode(): void {
  state = { active: false }
}

export function assertAgentExecutionAllowed(): void {
  if (!state.active) return
  const error = new Error(
    `系统处于配置维护模式，Agent 执行已禁用：${state.reason ?? '配置验证失败'}`,
  ) as Error & { code: string; details?: string[] }
  error.code = 'MAINTENANCE_MODE'
  error.details = state.details
  throw error
}
