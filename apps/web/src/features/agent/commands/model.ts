import type { AgentCommandRecord } from '@chery/protocol'

export const commandStatusLabels: Record<AgentCommandRecord['status'], string> = {
  running: '执行中', background: '后台执行中', cancel_requested: '已请求停止，等待确认',
  exited: '已退出', killed: '已停止', timed_out: '已超时', result_unknown: '结果未确认',
}
export const logStatusLabels: Record<AgentCommandRecord['logStatus'], string> = {
  active: '持续采集中', complete: '已完整保存', partial_truncated: '部分日志缺失', expired: '原始日志已过期',
  evicted_by_quota: '原始日志已因总容量限制移除', write_error: '日志保存异常',
}
export function canStopCommand(command?: AgentCommandRecord) {
  return !!command && ['running', 'background'].includes(command.status)
}
export const sourceLabels = { host_bash: '普通命令', managed_exec: '受管应用命令', managed_publish: '应用构建 / 启动' }
export function commandTime(value: number | null) { return value === null ? '尚未确认' : new Date(value).toLocaleString() }
